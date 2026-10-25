// Small real Office files, made in plain Node (no network, no Office): a .docx, an .xlsx and a .pptx, for the viewer and preview tests.
//   sampleDocx() / sampleXlsx() / samplePptx() -> Buffer          bombZip(name, bytes) -> a zip whose one part inflates to `bytes` zeros
// test/fixtures/office/*.docx|xlsx|pptx are these, written by `node test/helpers/_office-fixtures.js write` (kept as files so the tests read real
// bytes: .gitattributes keeps everything under test/fixtures byte for byte).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { zip, png, quadrants, deck, rect } = require('./_pptx-fixtures');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (list) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${esc(target)}"${ext ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
const TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';

const run = (text, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (inner, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const drawing = (rid, cx, cy) => `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Picture 1" descr="Four colored squares"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

// A document with a title, two headings, formatted runs, a link, bullet and numbered lists, a shaded table, a picture and a page break.
function sampleDocx() {
  const styles = `<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style><w:style w:type="paragraph" w:styleId="MyHead"><w:name w:val="My Head"/><w:basedOn w:val="Heading2"/></w:style></w:styles>`;
  const numbering = `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const item = (text, numId, ilvl = 0) => para(run(text), `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);
  const cell = (text, fill) => `<w:tc><w:tcPr>${fill ? `<w:shd w:val="clear" w:fill="${fill}"/>` : ''}</w:tcPr>${para(run(text, fill ? '<w:b/>' : ''))}</w:tc>`;
  const body = [
    para(run('Quarterly Report'), '<w:pStyle w:val="Title"/>'),
    para(run('Summary'), '<w:pStyle w:val="Heading1"/>'),
    para(run('Revenue grew ') + run('strongly', '<w:b/>') + run(' this quarter, ') + run('with care', '<w:i/>') + run(' and ') + run('underline', '<w:u w:val="single"/>') + run('. See ') + '<w:hyperlink r:id="rIdLink">' + run('the site', '<w:color w:val="0563C1"/>') + '</w:hyperlink>' + run('.')),
    para(run('Details'), '<w:pStyle w:val="MyHead"/>'),
    item('First bullet', 1), item('Second bullet', 1), item('Nested bullet', 1, 1),
    item('Step one', 2), item('Step two', 2), item('Sub step', 2, 1),
    `<w:tbl><w:tr>${cell('Region', 'D9E2F3')}${cell('Sales', 'D9E2F3')}</w:tr><w:tr>${cell('North')}${cell('1,200')}</w:tr><w:tr>${cell('South')}${cell('950')}</w:tr></w:tbl>`,
    para(drawing('rIdImg', 1143000, 1143000)),
    para('<w:r><w:br w:type="page"/></w:r>'),
    para(run('Second page text.')),
  ].join('');
  return zip({
    '[Content_Types].xml': TYPES,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    'word/styles.xml': styles,
    'word/numbering.xml': numbering,
    'word/_rels/document.xml.rels': rels([['rIdImg', 'image', 'media/image1.png'], ['rIdLink', 'hyperlink', 'https://example.com/', true]]),
    'word/media/image1.png': quadrants(60, 60),
  });
}

const X = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
// A workbook: "Budget" (a merged title, a bold shaded header, strings, numbers, a percent, a date, a formula's cached value) and "Notes".
function sampleXlsx() {
  const strings = ['Budget 2026', 'Item', 'Cost', 'Share', 'Due', 'Rent', 'Food', 'Total'];
  const si = (s) => `<si><t>${esc(s)}</t></si>`;
  const sheet1 = `<?xml version="1.0"?><worksheet ${X}><cols><col min="1" max="1" width="18" customWidth="1"/></cols><sheetData>`
    + `<row r="1"><c r="A1" t="s" s="1"><v>0</v></c></row>`
    + `<row r="2"><c r="A2" t="s" s="2"><v>1</v></c><c r="B2" t="s" s="2"><v>2</v></c><c r="C2" t="s" s="2"><v>3</v></c><c r="D2" t="s" s="2"><v>4</v></c></row>`
    + `<row r="3"><c r="A3" t="s"><v>5</v></c><c r="B3"><v>1200.5</v></c><c r="C3" s="3"><v>0.6</v></c><c r="D3" s="4"><v>46023</v></c></row>`
    + `<row r="4"><c r="A4" t="s"><v>6</v></c><c r="B4"><v>800</v></c><c r="C4" s="3"><v>0.4</v></c><c r="D4" s="4"><v>46054.5</v></c></row>`
    + `<row r="5"><c r="A5" t="s"><v>7</v></c><c r="B5"><f>SUM(B3:B4)</f><v>2000.5</v></c><c r="C5" s="3"><v>1</v></c><c r="D5" t="b"><v>1</v></c></row>`
    + `</sheetData><mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells></worksheet>`;
  const sheet2 = `<?xml version="1.0"?><worksheet ${X}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Second sheet note</t></is></c></row></sheetData></worksheet>`;
  const styles = `<?xml version="1.0"?><styleSheet ${X}><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="3"><font><sz val="11"/></font><font><b/><sz val="14"/></font><font><b/><color rgb="FFFFFFFF"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/></patternFill></fill></fills><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="0" fontId="1" fillId="0" applyFont="1"><alignment horizontal="center"/></xf><xf numFmtId="0" fontId="2" fillId="2" applyFont="1" applyFill="1"/><xf numFmtId="9" fontId="0" fillId="0"/><xf numFmtId="14" fontId="0" fillId="0"/></cellXfs></styleSheet>`;
  return zip({
    '[Content_Types].xml': TYPES,
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${X}><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/><sheet name="Secret" sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'worksheet', 'worksheets/sheet2.xml'], ['rId3', 'worksheet', 'worksheets/sheet3.xml']]),
    'xl/worksheets/sheet1.xml': sheet1,
    'xl/worksheets/sheet2.xml': sheet2,
    'xl/worksheets/sheet3.xml': `<?xml version="1.0"?><worksheet ${X}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden</t></is></c></row></sheetData></worksheet>`,
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst ${X} count="${strings.length}" uniqueCount="${strings.length}">${strings.map(si).join('')}</sst>`,
    'xl/styles.xml': styles,
  });
}

// A two-slide deck with a title and a colored box (the real slide drawing is tested in pptx-units.js: this one is for the previews).
function samplePptx() {
  return deck({ slides: [{ shapes: rect({ id: 2, box: { x: 60, y: 60, w: 600, h: 100 }, color: '4472C4', text: 'Launch plan' }) + rect({ id: 3, box: { x: 60, y: 200, w: 300, h: 120 }, color: 'FFC000', text: 'Q3 goals' }) }, { shapes: rect({ id: 2, box: { x: 60, y: 60, w: 600, h: 100 }, color: '70AD47', text: 'Second slide' }) }] });
}

// A zip whose single part is `bytes` zeros deflated (a few KB on disk): the inflate cap must stop it.
function bombZip(name, bytes) {
  const raw = Buffer.alloc(bytes);
  const packed = zlib.deflateRawSync(raw);
  const nameBuf = Buffer.from(name);
  const crc = zlib.crc32(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + nameBuf.length, 12); end.writeUInt32LE(30 + nameBuf.length + packed.length, 16);
  return Buffer.concat([local, nameBuf, packed, central, nameBuf, end]);
}

module.exports = { sampleDocx, sampleXlsx, samplePptx, bombZip, png, zip };

if (require.main === module && process.argv[2] === 'write') {
  const dir = path.join(__dirname, '..', 'fixtures', 'office');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sample.docx'), sampleDocx());
  fs.writeFileSync(path.join(dir, 'sample.xlsx'), sampleXlsx());
  fs.writeFileSync(path.join(dir, 'sample.pptx'), samplePptx());
  console.log('wrote', dir);
}
