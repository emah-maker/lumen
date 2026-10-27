// [save as pdf] screenshot pdf:true: the tab printed to a PDF (what Ctrl+P → Save as PDF makes), saved in the Downloads folder under the page's
// title (never over another file) and, in a chat, attached to that chat as a file, so upload_file can put it on a site by its ref without
// access to the user's files. Loaded on the first such call (perf-budget's module count).
const fs = require('fs');
const path = require('path');

const MAX_NAME = 80;

// "Unofficial Transcript | Banner" -> "Unofficial Transcript - Banner.pdf"
function pdfName(title, url = '') {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* no address */ }
  const base = String(title || '').replace(/\s*\|\s*/g, ' - ').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, MAX_NAME).trim();
  return `${base || host || 'Page'}.pdf`;
}

// `name` in `dir`, or "name (2).pdf", "name (3).pdf"... when it is taken.
function freePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const file = path.join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    if (!fs.existsSync(file)) return file;
  }
  throw new Error('The Downloads folder already has too many files of that name.');
}

// A page still settling can fail once; asking again a moment later works (as the print preview does).
async function printOf(wc) {
  const options = { printBackground: true, preferCSSPageSize: true };
  try { return await wc.printToPDF(options); } catch (err) {
    await new Promise((r) => setTimeout(r, 400));
    if (wc.isDestroyed()) throw err;
    return wc.printToPDF(options);
  }
}

// -> the tool's answer. dir: the Downloads folder; uploads + chatId: the chat's file store (features/upload-files.js), when there is a chat.
async function savePagePdf(wc, { dir, uploads = null, chatId = null, onSaved = () => {} } = {}) {
  const url = wc.getURL();
  if (!/^(https?|file):/i.test(url)) throw new Error('Only web pages and local files can be saved as a PDF.');
  if (!dir) throw new Error('No Downloads folder to save the PDF in.');
  const data = await printOf(wc);
  if (!data?.length) throw new Error('The page printed as an empty PDF. Wait for it to load and try again.');
  fs.mkdirSync(dir, { recursive: true });
  const file = freePath(dir, pdfName(wc.getTitle(), url));
  fs.writeFileSync(file, data, { flag: 'wx' }); // (wx: never over a file that appeared meanwhile)
  onSaved(file);
  const pages = (data.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  const lines = [`Saved ${url} as a PDF${pages ? ` (${pages} page${pages === 1 ? '' : 's'})` : ''}: ${file}`];
  if (uploads && chatId != null) {
    try {
      const stashed = uploads.stash({ name: path.basename(file), type: 'application/pdf', data });
      const [held] = uploads.adopt(chatId, [stashed.ref]);
      if (held) lines.push(`Attached to this chat as file ref ${held.ref}: upload_file files:["${held.ref}"] puts it on a site.`);
    } catch (err) { lines.push(`(Not attached to the chat: ${err.message})`); }
  }
  return lines.join('\n');
}

module.exports = { savePagePdf, pdfName, freePath };
