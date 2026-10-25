// Tabs that show a file, not a web page: a PDF in Lumen's viewer (lumen-pdf://app/viewer.html?u=...), a deck in the slide viewer
// (renderer/slides.html?u=...), a file from disk (file://: text, code, images, spreadsheets) and a PDF, document or picture on the
// web. Organize (browser/tab-groups.js) used to see the viewer's address, which says nothing about the file, or skipped them.
// This module reads a file tab's real identity from its address: the file name, its folder, its type. Pure: no Electron, no disk
// (readTextHead is the one function that reads a file, for main.js).
//
//   addressOf(url)         the file's own address behind a tab's address, or '' when the tab is not a file
//   identify(url, opts)    { kind, label, typeName, ext, name, folder, local, address, title, topicUrl, topicText, groupKey, groupName } or null
//   iconKind(url)          which icon the strip shows for the tab: 'pdf' | 'slides' | 'mail' | 'image' | 'sheet' | 'code' | 'file' ('' for a web page)
//
// Nothing here ever includes a full path in what leaves the computer: topicUrl and the names use at most the last two folder names.

const path = require('path');
const { pathToFileURL } = require('url');

const KINDS = {
  pdf: { exts: ['pdf'], label: 'PDFs', typeName: 'PDF' },
  slides: { exts: ['pptx', 'ppt', 'pps', 'ppsx', 'key', 'odp'], label: 'Slides', typeName: 'Slides' },
  sheet: { exts: ['xlsx', 'xls', 'xlsm', 'csv', 'tsv', 'ods', 'numbers'], label: 'Files', typeName: 'Spreadsheet' },
  doc: { exts: ['docx', 'doc', 'odt', 'rtf', 'pages', 'epub'], label: 'Files', typeName: 'Document' },
  mail: { exts: ['eml'], label: 'Email', typeName: 'Email' },
  image: { exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'tif', 'tiff', 'ico'], label: 'Images', typeName: 'Image' },
  text: { exts: ['txt', 'md', 'markdown', 'log', 'tex', 'rst', 'org'], label: 'Files', typeName: 'Text' },
  code: { exts: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'ps1', 'sql', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'scss', 'm', 'r', 'swift', 'kt', 'ipynb'], label: 'Files', typeName: 'Code' },
};
const KIND_OF = new Map();
for (const [kind, { exts }] of Object.entries(KINDS)) for (const e of exts) KIND_OF.set(e, kind);
// What a file on the WEB must be to count as a file tab: documents and pictures. A ".py" or ".html" address on the web is a page.
const WEB_KINDS = new Set(['pdf', 'slides', 'sheet', 'doc', 'image']);
// Folders that say nothing about a file's subject ("Downloads"): it is grouped by its type instead, and the name is no topic word.
const GENERIC_FOLDERS = new Set(['downloads', 'download', 'documents', 'document', 'desktop', 'temp', 'tmp', 'users', 'home', 'my documents', 'onedrive', 'dropbox', 'google drive', 'icloud drive', 'pictures', 'files', 'new folder', 'untitled folder', 'screenshots', 'appdata', 'local', 'public', 'volumes', 'mnt', 'media', 'var', 'private']);
const MAX_NAME = 120;

const parse = (url) => { try { return new URL(String(url)); } catch { return null; } };
const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,6})$/.exec(String(name)); return m ? m[1].toLowerCase() : ''; };
const kindOfExt = (ext) => KIND_OF.get(ext) || 'file';
const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

const isHttp = (u) => u.protocol === 'http:' || u.protocol === 'https:';
// Lumen's own pages that are files on disk (the new-tab page, Settings, the viewers ...): never a file the user opened.
const isOwnPage = (u) => u.protocol === 'file:' && /\/renderer\/[^/]*\.html?$/i.test(u.pathname);

// The file a tab shows. The two viewers keep the file's own address in ?u=.
function addressOf(url) {
  const u = parse(url);
  if (!u) return '';
  if (u.protocol === 'lumen-pdf:') {
    if (u.host !== 'app' || u.pathname !== '/viewer.html') return '';
    const inner = parse(u.searchParams.get('u') || '');
    return inner && (isHttp(inner) || inner.protocol === 'file:') ? inner.href : '';
  }
  if (u.protocol === 'file:' && /\/renderer\/(slides|eml|office)\.html$/i.test(u.pathname)) {
    const inner = parse(u.searchParams.get('u') || '');
    return inner && inner.protocol === 'file:' ? inner.href : '';
  }
  if (u.protocol === 'file:') return isOwnPage(u) ? '' : u.href;
  if (isHttp(u) && WEB_KINDS.has(kindOfExt(extOf(decode(u.pathname.split('/').pop() || ''))))) return u.href;
  return '';
}

// "ME2350_Lecture-3 (1).pdf" -> "ME 2350 Lecture 3"; the course code stays one piece ("ME 2350").
function humanize(stem) {
  return String(stem || '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.+]+/g, ' ')
    .replace(/\b([A-Za-z]-\d{1,2}|\d{4}-[A-Za-z]{2,4})\b|-+/g, (m, form) => form || ' ') // "a-b" -> "a b"; "W-2" and "1099-INT" keep theirs
    .replace(/\b([A-Za-z]{2,5})[\s-]?(\d{3,4}[A-Za-z]?)\b/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// A title a PDF carries that says nothing ("Microsoft Word - lecture3.docx", "untitled", "Slide 1"): the file's name is better.
const JUNK_TITLE = /^(microsoft (word|powerpoint|excel)\b|untitled|document\d*$|slide \d+$|powerpoint presentation$|new document|pdf$|scan|image\d*$|page \d+$)/i;
const looksLikeFileName = (s) => /\.[A-Za-z0-9]{2,5}$/.test(String(s).trim()) && !/\s{2,}/.test(s);

const isGeneric = (folder) => GENERIC_FOLDERS.has(String(folder).toLowerCase());
// Folders that only sort a course's or project's files ("Week 6", "Lectures", "Homework"): the folder above them names the subject.
const STRUCTURAL = /^(?:week|wk|unit|module|chapter|ch|lecture|lectures|lec|slides|notes|homework|hw|assignments?|labs?|readings?|exams?|handouts?|resources|materials|course materials|archive|old|misc|new|final|drafts?|src|tests?|docs|build|dist)(?:[\s_-]*\d+)?$/i;

// The folders above a local file: { folder: the one it is in, home: the nearest one that names a subject ("ME 2350", "Physics": not Downloads, not
// "Week 6"), path: up to and including home, generic: there is no such folder }.
function foldersOf(u) {
  const parts = decode(u.pathname).split('/').filter(Boolean);
  parts.pop(); // the file's own name
  if (/^[A-Za-z]:$/.test(parts[0] || '')) parts.shift(); // a Windows drive
  const dirs = parts.map((p, i) => ({ p, user: /^(users|home)$/i.test(parts[i - 1] || '') })); // the folder under Users/home is the person's name
  const last = parts[parts.length - 1] || '';
  const lastIsUser = dirs.length > 0 && dirs[dirs.length - 1].user;
  const folder = last && !lastIsUser ? last : '';
  let at = -1;
  dirs.forEach(({ p, user }, i) => { if (!user && !isGeneric(p) && !STRUCTURAL.test(p)) at = i; });
  const home = at >= 0 ? parts[at] : '';
  return { folder, home, topic: home ? [home] : [], generic: !home, path: parts.slice(0, at + 1).join('/') };
}

const clipTo = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1).trim()}…` : String(s));

// What a file tab is. url: the tab's address (a viewer's or the file's own). title: the tab's title (a PDF's own title once the viewer has read it,
// else the file name). text: a short snippet of the file's first page, when one was read (main.js). null when the tab is no file.
function identify(url, { title = '', text = '' } = {}) {
  const address = addressOf(url);
  if (!address) return null;
  const u = parse(address);
  const local = u.protocol === 'file:';
  const name = decode(u.pathname.split('/').pop() || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_NAME);
  const ext = extOf(name);
  const kind = kindOfExt(ext);
  const info = KINDS[kind] || { label: 'Files', typeName: 'File' };
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
  const human = humanize(stem) || name;
  const shown = String(title || '').replace(/\s*\(\d+\s*[×x]\s*\d+\)\s*$/, '').trim(); // an image's title carries its size
  // The viewer's title is the file name until the PDF's own title is read: only a title that is neither is a document title.
  const docTitle = shown && shown !== name && shown !== stem && !looksLikeFileName(shown) && !JUNK_TITLE.test(shown) && shown.toLowerCase() !== 'pdf' ? shown : '';
  const f = local ? foldersOf(u) : { folder: '', home: '', topic: [], generic: true, path: '' };
  const snippet = String(text || '').replace(/\s+/g, ' ').trim();
  // A file in a folder that names its subject ("Kitchen remodel", "ME 2350") is about it: the folder is part of its title unless the title already says so.
  const homeWords = f.home ? humanize(f.home) : '';
  const named = homeWords && !(docTitle || human).toLowerCase().includes(homeWords.toLowerCase());
  const shownTitle = `${docTitle || human}${named ? ` - ${homeWords}` : ''}`;
  // What topic grouping reads: the folder names and the file's name are real words, so they ride along as words of the page.
  const topicText = [docTitle ? human : '', snippet].filter(Boolean).join(' ');
  // The address the topic stage sees: a web file keeps its own (its site is evidence); a local one has no site, only the words of its folders.
  const topicUrl = local ? `file:///${[...f.topic.map((p) => encodeURIComponent(p)), encodeURIComponent(stem || name)].join('/')}` : address;
  let groupKey = '';
  let groupName = '';
  if (local) {
    if (f.generic) { groupKey = `file:type:${info.label.toLowerCase()}`; groupName = info.label; } else { groupKey = `file:dir:${f.path.toLowerCase()}`; groupName = clipTo(humanize(f.home) || f.home, 24); }
  }
  return { kind, label: info.label, typeName: info.typeName, ext, name, stem, human, folder: f.folder, folderTopic: f.topic, genericFolder: f.generic, local, address, title: shownTitle, snippet, topicUrl, topicText, groupKey, groupName };
}

// The strip's icon for a tab that shows a file.
function iconKind(url) {
  const address = addressOf(url);
  if (!address) return '';
  const kind = kindOfExt(extOf(decode(parse(address).pathname.split('/').pop() || '')));
  return ['pdf', 'slides', 'mail', 'image', 'sheet', 'code'].includes(kind) ? kind : 'file';
}

// ---- Word and Excel files in a tab (renderer/office.html, filled in by features/office-viewer.js; the tab wiring in main.js needs no more than these checks)
const OFFICE_VIEWER_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'office.html')).href;
const isOfficeName = (name) => /\.(?:docx|xlsx)$/i.test(String(name || '').split(/[?#]/)[0]);
const isLocalOffice = (url) => { const u = parse(url); return Boolean(u) && u.protocol === 'file:' && isOfficeName(u.pathname); };
const isOfficeViewerUrl = (url) => typeof url === 'string' && url.split(/[?#]/)[0].toLowerCase() === OFFICE_VIEWER_URL.toLowerCase();
const officeViewerUrl = (fileUrl) => `${OFFICE_VIEWER_URL}?${new URLSearchParams({ u: fileUrl })}`;
// The file a viewer address shows (a file: URL of a .docx or .xlsx), or null.
function officeUrlOf(url) {
  if (!isOfficeViewerUrl(url)) return null;
  const inner = parse(url).searchParams.get('u');
  return inner && isLocalOffice(inner) ? inner : null;
}
// A download Chromium starts for a local .docx or .xlsx opened in a tab: the viewer takes its place (a file from the web is saved as usual).
const shouldOpenOfficeInPlace = ({ url, filename } = {}) => isLocalOffice(url) && isOfficeName(filename || url);

// A new group made from one file tab by hand ("New Group"): named for the file's folder, else its type.
function nameFor(url, title = '') {
  const id = identify(url, { title });
  return id ? id.groupName || id.label : '';
}

// The first bytes of a local text or code file, as a short plain snippet (the words of a README or a script's opening comment). Never more than `max` characters.
async function readTextHead(address, { max = 300, bytes = 2048 } = {}) {
  const id = identify(address);
  if (!id || !id.local || !['text', 'code'].includes(id.kind) || /^(?:json|xml|html|htm|css|scss|ipynb)$/i.test(id.ext)) return '';
  const { fileURLToPath } = require('url');
  const fs = require('fs');
  let handle;
  try {
    handle = await fs.promises.open(fileURLToPath(id.address), 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    const head = buf.subarray(0, bytesRead).toString('utf8');
    if (head.includes('\u0000')) return ''; // not text
    return head.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  } catch { return ''; } finally { await handle?.close().catch(() => {}); }
}

module.exports = { OFFICE_VIEWER_URL, isOfficeName, isLocalOffice, isOfficeViewerUrl, officeViewerUrl, officeUrlOf, shouldOpenOfficeInPlace, addressOf, identify, iconKind, nameFor, readTextHead, humanize, GENERIC_FOLDERS, KINDS };
