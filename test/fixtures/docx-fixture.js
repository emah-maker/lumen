// A small real .docx (a zip of XML parts) for the download tests: makeDocx(['Heading text', 'A paragraph.']) -> Buffer.
// The first paragraph is a Heading1; a table of two cells follows when `table` is given.
const zlib = require('zlib');

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const packed = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc32(raw), 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    locals.push(head, nameBuf, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(raw), 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += head.length + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function makeDocx(paragraphs, { table = null } = {}) {
  const body = paragraphs.map((text, i) => (i === 0
    ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${esc(text)}</w:t></w:r></w:p>`
    : `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`)).join('');
  const tbl = table ? `<w:tbl>${table.map((row) => `<w:tr>${row.map((c) => `<w:tc><w:p><w:r><w:t>${esc(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>` : '';
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}${tbl}</w:body></w:document>`,
  });
}

module.exports = { makeDocx, makeZip };
