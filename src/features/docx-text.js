// ---------- Word (.docx) text for the AI ----------
// A .docx is a zip of XML parts, so its words come out the way a deck's do (features/pptx.js: the same dependency-free zip reader,
// with the same size, entry and XML limits, so a hostile file can't take the browser down). Only word/document.xml is read: paragraphs
// (headings and list items as lines), table rows (cells joined by a tab), tab and line-break characters. Pictures, comments, tracked
// deletions, headers and footers are left out. No DTDs, no external entities, nothing is fetched.
const { createZipReader, parseXml, PptxError } = require('./pptx');

const MAX_DOCX_BYTES = 100 * 1024 * 1024;
const MAX_INFLATED = 60 * 1024 * 1024;

const isDocxName = (name) => /\.docx$/i.test(String(name || '').split(/[?#]/)[0]);

function paragraphText(p) {
  let out = '';
  const visit = (node) => {
    for (const c of node.children) {
      if (c.name === 'del' || c.name === 'delText' || c.name === 'instrText') continue; // a tracked deletion, a field's code
      if (c.name === 't') out += c.text;
      else if (c.name === 'tab') out += '\t';
      else if (c.name === 'br' || c.name === 'cr') out += '\n';
      else if (c.name === 'noBreakHyphen') out += '-';
      else visit(c);
    }
  };
  visit(p);
  return out;
}

function blocks(node, lines) {
  for (const c of node.children) {
    if (c.name === 'p') {
      const style = c.children.find((k) => k.name === 'pPr')?.children.find((k) => k.name === 'pStyle')?.attrs?.['w:val'] || '';
      const heading = /^Heading([1-6])$/i.exec(style) || (/^Title$/i.test(style) ? [0, '1'] : null);
      const text = paragraphText(c);
      lines.push(heading && text.trim() ? `${'#'.repeat(Number(heading[1]))} ${text.trim()}` : text);
    } else if (c.name === 'tbl') {
      for (const row of c.children.filter((k) => k.name === 'tr')) {
        const cells = row.children.filter((k) => k.name === 'tc').map((tc) => { const inner = []; blocks(tc, inner); return inner.join(' ').replace(/\s+/g, ' ').trim(); });
        lines.push(cells.join('\t'));
      }
    } else if (c.name === 'document' || c.name === 'body' || c.name === 'sdt' || c.name === 'sdtContent' || c.name === 'ins') {
      blocks(c, lines);
    }
  }
}

// -> the document's text (paragraphs separated by a newline). Throws PptxError with a plain message for a file that is not a .docx.
async function docxText(buf, { maxChars = 1e6 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length > MAX_DOCX_BYTES) throw new PptxError('This Word file is too large to read here.');
  let zip;
  try { zip = createZipReader(buf, { maxBytes: MAX_INFLATED, root: 'word/document.xml' }); } catch (err) {
    throw err instanceof PptxError && /password/.test(err.message) ? new PptxError('This Word file is password-protected.') : new PptxError('This file is not a Word document (.docx), or it is damaged.');
  }
  const xml = await zip.text('word/document.xml');
  if (!xml) throw new PptxError('This file is not a Word document (.docx), or it is damaged.');
  const lines = [];
  blocks(parseXml(xml), lines);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
}

module.exports = { docxText, isDocxName };
