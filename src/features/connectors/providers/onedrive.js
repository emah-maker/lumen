// OneDrive (personal, or a school's or employer's OneDrive for Business) through the shared Microsoft sign-in (connectors/microsoft-auth.js),
// with Microsoft Graph at graph.microsoft.com. Read only (Files.Read): find files, list a folder, read a file's text. A Word document (.docx),
// an Excel workbook (.xlsx) and a PowerPoint deck (.pptx) are read by Lumen's own file readers (features/office-doc.js, pptx.js: no macros run, nothing
// fetched), plain text files as text; other files give their details only. The file's bytes come from the short-lived download address Graph
// gives (ctx.download: https, a Microsoft file host only, no sign-in header sent to it, nothing followed).
'use strict';
const { flat, clip, ConnectorError } = require('../util');
const X = require('./_graph');

const SELECT = 'id,name,size,lastModifiedDateTime,webUrl,folder,file';
const q = (o) => `?${Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
const idOf = (id) => encodeURIComponent(String(id));
const INFLATED = 40 * 1024 * 1024; // what a zipped Office file may inflate to (a zip bomb stops there)
const READ_MAX = 15 * 1024 * 1024; // the biggest file that is downloaded to read
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|tex|bib|py|m|c|h|cpp|js|ts|java|sql|ya?ml|log|ini|cfg|ino|gcode|nc)$/i;

async function verify(ctx) {
  const res = await ctx.http(`/me${q({ $select: 'mail,userPrincipalName' })}`, { allowAuth: true });
  if (!res.ok) return { status: res.status, message: res.status === 403 ? X.failure(ctx, res).message : '' };
  let b = {};
  try { b = JSON.parse(res.text); } catch { /* an answer without a name */ }
  return { status: 200, account: flat(b.mail || b.userPrincipalName, 80) || ctx.email };
}

const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const kind = (f) => (f.folder ? 'folder' : /\.docx?$/i.test(f.name || '') ? 'word' : /\.xlsx?$/i.test(f.name || '') ? 'excel' : /\.pptx?$/i.test(f.name || '') ? 'slides' : /\.pdf$/i.test(f.name || '') ? 'pdf' : 'file');
const day = (iso) => (Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 10) : '');
const line = (f) => `${flat(f.id, 200)}  ${kind(f)}  ${day(f.lastModifiedDateTime)}  ${flat(f.name, 160)}${f.file && Number(f.size) ? ` (${size(Number(f.size))})` : ''}`;

// A Word document's blocks (office-doc.js) as plain text.
function blocksText(blocks, out = [], depth = 0) {
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b?.t === 'p') {
      const text = (Array.isArray(b.runs) ? b.runs : []).map((r) => (typeof r?.text === 'string' ? r.text : '')).join('');
      out.push(`${/^h[1-6]$|^title$/.test(b.style || '') ? '# ' : ''}${b.list ? `${b.list.marker || '-'} ` : ''}${text}`);
    } else if (b?.t === 'table' && depth < 4) {
      for (const row of Array.isArray(b.rows) ? b.rows : []) out.push((Array.isArray(row) ? row : []).map((c) => blocksText(c?.blocks, [], depth + 1).join(' ').trim()).join(' | '));
    }
  }
  return out;
}
function sheetsText(sheets) {
  return (Array.isArray(sheets) ? sheets : []).slice(0, 5).map((s) => `## ${flat(s.name, 60)}\n${(Array.isArray(s.rows) ? s.rows : []).slice(0, 200).map((r) => (Array.isArray(r) ? r : []).slice(0, 30).map((c) => flat(c?.v ?? '', 120)).join('\t')).join('\n')}`).join('\n\n');
}

async function readFile(ctx, f, buf) {
  const name = String(f.name || '');
  try {
    if (/\.docx$/i.test(name)) return blocksText((await Promise.resolve(require('../../office-doc').parseDocx(buf, { maxInflated: INFLATED }))).blocks).join('\n');
    if (/\.xlsx$/i.test(name)) return sheetsText((await Promise.resolve(require('../../office-doc').parseXlsx(buf, { maxRows: 200, maxCols: 30, maxInflated: INFLATED }))).sheets);
    if (/\.pptx$/i.test(name)) return (await require('../../pptx').extractSlideTexts(buf)).map((t, i) => `## Slide ${i + 1}\n${t}`).join('\n\n');
  } catch { throw new ConnectorError(`Lumen couldn’t read “${flat(name, 80)}” (it may be damaged or password protected).`, 'other'); }
  return buf.toString('utf8');
}

const actions = {
  async files(ctx, { query, folder_id: folder, max = 15 } = {}) {
    let path;
    if (query) path = `/me/drive/root/search(q='${encodeURIComponent(String(query).replace(/'/g, "''"))}')${q({ $top: String(max), $select: SELECT })}`;
    else if (folder) path = `/me/drive/items/${idOf(folder)}/children${q({ $top: String(max), $select: SELECT, $orderby: 'lastModifiedDateTime desc' })}`;
    else path = `/me/drive/recent${q({ $top: String(max) })}`;
    const b = X.json(ctx, await ctx.http(path), { thing: 'that folder' });
    const items = (Array.isArray(b.value) ? b.value : []).filter((f) => f && f.id);
    return items.length ? items.slice(0, max).map(line).join('\n') : 'No files found.';
  },

  async read(ctx, { id }) {
    const f = X.json(ctx, await ctx.http(`/me/drive/items/${idOf(id)}`), { thing: 'that file' });
    const head = `${line(f)}${X.webLink(f.webUrl) ? `\n${f.webUrl}` : ''}`;
    if (f.folder) return `${head}\nThis is a folder (${Number(f.folder.childCount) || 0} items): list it with files and folder_id.`;
    const url = f['@microsoft.graph.downloadUrl'];
    const readable = /\.(docx|xlsx|pptx)$/i.test(f.name || '') || TEXT_EXT.test(f.name || '') || /^text\//.test(f.file?.mimeType || '');
    if (!readable || !url) return `${head}\nLumen reads Word, Excel and PowerPoint files and plain text files; for this one it can give only the details above.`;
    if (Number(f.size) > READ_MAX) return `${head}\nThis file is too big to read here (over ${size(READ_MAX)}).`;
    const buf = await ctx.download(url, { max: READ_MAX });
    const text = await readFile(ctx, f, buf);
    return `${head}\n\n${text.trim() ? clip(text, 12000) : '(no text)'}`;
  },
};

module.exports = { verify, actions, blocksText, sheetsText };
