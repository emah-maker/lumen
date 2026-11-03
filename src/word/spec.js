// [word] What the "word" tool accepts, in plain functions (no Electron, no Word): the action list, the checks every argument goes through,
// what an action costs in trust (read / edit / save), the readable step labels and the wrapper document text travels in.
// Loaded on first use of the tool, never at startup. Nothing in here ever builds code from a value: arguments leave as JSON data.
'use strict';

const path = require('path');

const ACTIONS = ['list', 'open', 'new', 'read', 'insert', 'replace', 'style', 'format', 'table', 'image', 'comment', 'track', 'save', 'save_as', 'show'];
// Changes that open, edit, save or show something: refused in hands-off mode and asked about in a card.
const EDITS = new Set(['insert', 'replace', 'style', 'format', 'table', 'image', 'comment', 'track']);
const SAVES = new Set(['save', 'save_as']);
const ACTING = new Set(['open', 'new', 'show', ...EDITS, ...SAVES]);
const STYLES = { normal: 'Normal', 'heading 1': 'Heading 1', 'heading 2': 'Heading 2', 'heading 3': 'Heading 3', title: 'Title', 'list bullet': 'List Bullet', bullet: 'List Bullet', bullets: 'List Bullet', 'list number': 'List Number', numbered: 'List Number', number: 'List Number', quote: 'Quote' };
const AT = ['end', 'start', 'after', 'section_end'];
const OPEN_EXT = /\.(docx|doc|rtf|odt|txt)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp)$/i;
const MAX = { text: 60000, find: 255, cell: 2000, rows: 200, cols: 30, path: 1000, name: 300, comment: 4000, image: 20 * 1024 * 1024 };

class WordError extends Error {}
const fail = (msg) => { throw new WordError(msg); };

// A path is a full local path to a real place: no network (UNC) paths (opening one sends Windows sign-in hashes to that machine), no device
// paths, no control characters, no "..". Relative paths are refused too: Word's own folder is not where the user means.
function checkPath(value, what = 'path') {
  const p = typeof value === 'string' ? value.trim() : '';
  if (!p) fail(`Give the ${what} (a full path such as C:\\Users\\me\\Documents\\Report.docx).`);
  if (p.length > MAX.path) fail(`That ${what} is too long.`);
  if (/[\u0000-\u001f]/.test(p)) fail(`That ${what} has characters a file name cannot have.`);
  if (/^[\\/]{2}/.test(p) || /^[a-z]+:\/\//i.test(p)) fail('Network paths and web addresses are not used here. Save the file to this computer first.');
  if (!(/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('~'))) fail(`Give the ${what} as a full path (starting with a drive letter such as C:\\).`);
  if (p.split(/[\\/]/).includes('..')) fail(`The ${what} may not contain "..".`);
  if (/[<>"|?*]/.test(p.replace(/^[a-zA-Z]:/, ''))) fail(`That ${what} has characters a file name cannot have.`);
  return p;
}

// Is the open document at docPath (as Word lists it) the file `want` names? Word lists a document it opened from a OneDrive folder by its web
// address (https://…sharepoint.com/personal/…/Documents/Lab/Report.docx, or https://d.docs.live.net/…/Lab/Report.docx), while the AI names the
// local file (C:\Users\me\OneDrive - School\Lab\Report.docx): the same document when the address ends with the path below the OneDrive folder.
function sameDoc(docPath, want) {
  const a = String(docPath || '').trim();
  const w = String(want || '').trim();
  if (!a || !w) return false;
  const key = (p) => p.replace(/\//g, '\\').toLowerCase();
  if (key(a) === key(w)) return true;
  if (!/^https?:\/\//i.test(a) || /^[a-z]+:\/\//i.test(w)) return false;
  let page;
  try { page = decodeURIComponent(new URL(a).pathname).toLowerCase(); } catch { return false; }
  const parts = w.split(/[\\/]+/).filter(Boolean);
  const root = parts.findLastIndex((s) => /^onedrive( - .+)?$/i.test(s));
  if (root < 0 || root === parts.length - 1) return false;
  return page.endsWith(`/${parts.slice(root + 1).join('/').toLowerCase()}`);
}

const str = (v, name, max, { required = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) fail(`${name} is required for this action.`); return undefined; }
  if (typeof v !== 'string') fail(`${name} must be text.`);
  if (v.length > max) fail(`${name} is too long (${v.length} characters; at most ${max}).`);
  return v;
};

function styleName(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const key = String(v).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!STYLES[key]) fail(`Unknown style "${String(v).slice(0, 40)}". Use Normal, Heading 1, Heading 2, Heading 3, Title, List Bullet, List Number or Quote.`);
  return STYLES[key];
}

// Where new content goes.
function placeOf(input) {
  const at = input.at === undefined || input.at === '' ? 'end' : input.at;
  if (!AT.includes(at)) fail(`at must be one of ${AT.join(', ')}.`);
  const heading = str(input.heading, 'heading', MAX.find);
  if ((at === 'after' || at === 'section_end') && !heading) fail(`at "${at}" needs heading: the text of the heading or paragraph to go after.`);
  return { at, ...(heading ? { heading } : {}) };
}

function tableRows(rows) {
  if (!Array.isArray(rows) || !rows.length) fail('rows must be a list of rows, each a list of cell texts.');
  if (rows.length > MAX.rows) fail(`A table can have at most ${MAX.rows} rows here.`);
  let width = 0;
  const out = rows.map((row) => {
    if (!Array.isArray(row)) fail('Each row must be a list of cell texts.');
    if (row.length > MAX.cols) fail(`A table can have at most ${MAX.cols} columns here.`);
    width = Math.max(width, row.length);
    return row.map((c) => { const s = c === null || c === undefined ? '' : String(c); if (s.length > MAX.cell) fail(`A table cell can hold at most ${MAX.cell} characters.`); return s; });
  });
  if (!width) fail('The table has no columns.');
  return out.map((r) => { while (r.length < width) r.push(''); return r; });
}

// format: fonts and spacing (for a style, the paragraphs holding some text, or the whole document), margins and orientation (every section, or
// one), page breaks before paragraphs, heading styles and a table of contents. -> the clean fields (names as docx.formatDocx and host.ps1 take them).
const MARGINS = { normal: [1, 1, 1, 1], narrow: [0.5, 0.5, 0.5, 0.5], moderate: [1, 0.75, 1, 0.75], wide: [1, 2, 1, 2] };
const MARGIN_HELP = 'margins must be normal, narrow, moderate, wide, or inches: "1", "1 1.25" (top and bottom, then the sides) or "1 1 1 1" (top right bottom left).';
const num = (v, name, lo, hi) => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/\s*(pt|in)$/i, '')) : v; if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) fail(`${name} must be a number from ${lo} to ${hi}.`); return n; };
const texts = (v, name) => { const list = typeof v === 'string' ? [v] : v; if (!Array.isArray(list) || !list.length || list.length > 50 || list.some((t) => typeof t !== 'string' || !t.trim() || t.length > MAX.find)) fail(`${name} must be a list of paragraph texts (each as read shows it).`); return list.map((t) => t.trim()); };
function marginsOf(v) {
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') fail(MARGIN_HELP);
  const n = MARGINS[v.trim().toLowerCase()] || v.replace(/(inches|inch|in|")/gi, ' ').trim().split(/[\s,]+/).map(Number);
  if (![1, 2, 4].includes(n.length) || n.some((x) => !Number.isFinite(x) || x < 0 || x > 10)) fail(MARGIN_HELP);
  const [t, r, b, l] = n.length === 1 ? [n[0], n[0], n[0], n[0]] : n.length === 2 ? [n[0], n[1], n[0], n[1]] : n;
  return { top: t, right: r, bottom: b, left: l };
}
function formatOf(input) {
  const out = {};
  if (input.font !== undefined) { const font = str(input.font, 'font', 60, { required: true }).trim(); if (!/^[\p{L}\p{N} .'&()-]+$/u.test(font)) fail('font must be a font name, such as Calibri or Times New Roman.'); out.font = font; }
  if (input.size !== undefined) out.size = Math.round(num(input.size, 'size (points)', 1, 400) * 2) / 2;
  if (input.line_spacing !== undefined) { out.line = num(input.line_spacing, 'line_spacing', 0.5, 200); if (out.line > 5 && out.line < 6) fail('line_spacing is a multiple of a line (1, 1.15, 1.5, 2; at most 5) or an exact height in points (6 or more).'); }
  if (input.space_before !== undefined) out.before = num(input.space_before, 'space_before (points)', 0, 200);
  if (input.space_after !== undefined) out.after = num(input.space_after, 'space_after (points)', 0, 200);
  const style = styleName(input.style); if (style) out.style = style;
  const find = str(input.find, 'find', MAX.find); if (find) out.find = find;
  if (out.style && out.find) fail('Give style or find, not both: style changes a style, find the paragraphs holding that text.');
  if (input.margins !== undefined) out.margins = marginsOf(input.margins);
  if (input.orientation !== undefined) { if (!['portrait', 'landscape'].includes(input.orientation)) fail('orientation must be portrait or landscape.'); out.orientation = input.orientation; }
  if (input.section !== undefined) { if (!Number.isInteger(input.section) || input.section < 1) fail('section must be a section number (1 is the first).'); out.section = input.section; }
  if (input.page_break_before !== undefined) out.breaks = texts(input.page_break_before, 'page_break_before');
  if (input.headings !== undefined) out.headings = texts(input.headings, 'headings').map((t) => { const m = /^(#{1,3})\s+(.+)$/.exec(t); return m ? { text: m[2].trim(), level: m[1].length } : { text: t, level: 1 }; });
  if (input.toc !== undefined) { if (typeof input.toc !== 'boolean') fail('toc must be true (a table of contents).'); if (input.toc) out.toc = true; }
  const at = str(input.heading, 'heading', MAX.find); if (at) { if (!out.toc) fail('heading (where the table of contents goes) needs toc: true.'); out.tocAt = at; }
  const text = out.font !== undefined || out.size !== undefined || out.line !== undefined || out.before !== undefined || out.after !== undefined;
  if ((out.style || out.find) && !text) fail('style and find pick where font, size, line_spacing, space_before or space_after change; give one of those.');
  if (!text && !out.margins && !out.orientation && !out.breaks && !out.headings && !out.toc) fail('Give something to change: font, size, line_spacing, space_before, space_after, margins, orientation, page_break_before, headings or toc.');
  if (out.section && !out.margins && !out.orientation) fail('section picks where margins or orientation change; give one of those.');
  return out;
}

// What each change takes besides action, doc and path (tab_id: the MCP listing adds it to every tool). An argument it does not take is refused,
// not dropped: a model that sent replace's new text as new_text had the found text replaced with nothing, so its edit deleted what it meant to change.
const EDIT_ARGS = { insert: ['at', 'heading', 'text', 'style', 'bold', 'italic'], replace: ['find', 'replace'], style: ['find', 'style', 'bold', 'italic'], table: ['at', 'heading', 'rows'], image: ['at', 'heading', 'image'], comment: ['find', 'heading', 'comment', 'text'], track: ['on'], format: ['font', 'size', 'line_spacing', 'space_before', 'space_after', 'style', 'find', 'margins', 'orientation', 'section', 'page_break_before', 'toc', 'heading', 'headings'] };
const ARG_HINT = { replace: 'find (the exact text to change) and replace (the new text; "" deletes it)' };

// input -> { action, ...clean fields } or a WordError with a plain sentence for the AI.
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Give an action.');
  const action = input.action;
  if (!ACTIONS.includes(action)) fail(`action must be one of: ${ACTIONS.join(', ')}.`);
  if (EDIT_ARGS[action]) {
    const takes = new Set(['action', 'doc', 'path', 'tab_id', ...EDIT_ARGS[action]]);
    const odd = Object.keys(input).filter((k) => !takes.has(k) && input[k] !== undefined);
    if (odd.length) fail(`${action} does not take ${odd.map((k) => k.slice(0, 40)).join(', ')}, so nothing was changed. It takes ${ARG_HINT[action] || EDIT_ARGS[action].join(', ')}.`);
  }
  const out = { action };
  const doc = str(input.doc, 'doc', MAX.name);
  if (doc) out.doc = doc;
  const pathArg = input.path;
  switch (action) {
    case 'list': case 'show': case 'save': break;
    case 'open': out.path = checkPath(pathArg); if (!OPEN_EXT.test(out.path)) fail('Only Word documents are opened here (.docx, .doc, .rtf, .odt or .txt).'); break;
    case 'new': if (pathArg !== undefined && pathArg !== '') { out.path = checkPath(pathArg); if (!/\.docx$/i.test(out.path)) fail('A new document is saved as .docx.'); } break;
    case 'read': {
      if (pathArg !== undefined && pathArg !== '') out.path = checkPath(pathArg);
      const off = input.offset === undefined ? 0 : Number(input.offset);
      if (!Number.isInteger(off) || off < 0 || off > 1e7) fail('offset must be a whole number (the next_offset of the last read).');
      out.offset = off;
      break;
    }
    case 'insert': {
      if (pathArg !== undefined && pathArg !== '') out.path = checkPath(pathArg);
      Object.assign(out, placeOf(input));
      out.text = str(input.text, 'text', MAX.text, { required: true });
      const style = styleName(input.style); if (style) out.style = style;
      if (input.bold !== undefined) out.bold = input.bold === true;
      if (input.italic !== undefined) out.italic = input.italic === true;
      break;
    }
    case 'replace': {
      if (pathArg !== undefined && pathArg !== '') out.path = checkPath(pathArg);
      out.find = str(input.find, 'find', MAX.find, { required: true });
      if (typeof input.replace !== 'string') fail('replace is required: the new text (give "" to delete the found text), so nothing was changed.');
      out.replace = str(input.replace, 'replace', MAX.text) ?? '';
      break;
    }
    case 'style': {
      out.find = str(input.find, 'find', MAX.find, { required: true });
      const style = styleName(input.style); if (style) out.style = style;
      if (input.bold !== undefined) out.bold = input.bold === true;
      if (input.italic !== undefined) out.italic = input.italic === true;
      if (!out.style && out.bold === undefined && out.italic === undefined) fail('Give a style, bold or italic to apply.');
      break;
    }
    case 'format': if (pathArg !== undefined && pathArg !== '') out.path = checkPath(pathArg); Object.assign(out, formatOf(input)); break;
    case 'table': {
      if (pathArg !== undefined && pathArg !== '') out.path = checkPath(pathArg);
      Object.assign(out, placeOf(input));
      out.rows = tableRows(input.rows);
      break;
    }
    case 'image': Object.assign(out, placeOf(input)); out.image = checkPath(input.image, 'image path'); if (!IMAGE_EXT.test(out.image)) fail('Only .png, .jpg, .gif and .bmp pictures are inserted.'); break;
    case 'comment': {
      out.find = str(input.find ?? input.heading, 'find', MAX.find, { required: true });
      out.text = str(input.comment ?? input.text, 'comment', MAX.comment, { required: true });
      break;
    }
    case 'track': if (typeof input.on !== 'boolean') fail('on must be true or false.'); out.on = input.on; break;
    case 'save_as': {
      out.path = checkPath(pathArg);
      const m = /\.(docx|pdf)$/i.exec(out.path);
      if (!m) fail('Save as .docx or .pdf.');
      out.format = m[1].toLowerCase();
      break;
    }
    default: break;
  }
  return out;
}

const kind = (action) => (SAVES.has(action) ? 'save' : EDITS.has(action) ? 'edit' : ACTING.has(action) ? 'open' : 'read');
const baseName = (p) => path.win32.basename(String(p || '').replace(/\//g, '\\'));
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const lines = (text) => String(text || '').split(/\r\n|\r|\n/).filter((l) => l.length).length || 1;

// What a format call changes, in words, for its step label ("font Calibri, 1.5 line spacing, margins normal, 3 page breaks, a table of contents").
function formatParts(i = {}) {
  const parts = [];
  if (i.font) parts.push(`font ${clip(i.font, 30)}`);
  if (i.size) parts.push(`size ${i.size} pt`);
  const line = i.line_spacing ?? i.line; // (the tool's arguments, or validate's clean fields)
  if (line !== undefined) parts.push(Number(line) > 5 ? `${line} pt lines` : `${line} line spacing`);
  if ((i.space_before ?? i.before) !== undefined || (i.space_after ?? i.after) !== undefined) parts.push('paragraph spacing');
  const m = i.margins;
  if (m !== undefined) parts.push(m && typeof m === 'object' ? (m.top === m.right && m.top === m.bottom && m.top === m.left ? `${m.top} in margins` : 'margins') : `margins ${clip(m, 20)}`);
  if (i.orientation) parts.push(i.orientation);
  const pb = i.page_break_before ?? i.breaks;
  const nb = typeof pb === 'string' ? 1 : Array.isArray(pb) ? pb.length : 0;
  if (nb) parts.push(count(nb, 'page break', 'page breaks'));
  if (Array.isArray(i.headings) && i.headings.length) parts.push(count(i.headings.length, 'heading', 'headings'));
  if (i.toc) parts.push('a table of contents');
  return parts;
}

// The sentence in the chat's live card, before it runs (name: the document's file name, when known).
function stepLabel(input = {}, name = '') {
  const a = input?.action;
  const doc = name || (input?.doc ? clip(input.doc, 60) : input?.path && a !== 'save_as' ? baseName(input.path) : 'the document');
  const where = (i) => (i.at === 'start' ? ' at the start' : i.at === 'after' && i.heading ? ` after “${clip(i.heading, 40)}”` : i.at === 'section_end' && i.heading ? ` at the end of “${clip(i.heading, 40)}”` : ' at the end');
  switch (a) {
    case 'list': return 'Looking at the open Word documents';
    case 'open': return `Opening ${baseName(input.path) || 'a document'} in Word`;
    case 'new': return input.path ? `Creating ${baseName(input.path)}` : 'Starting a new Word document';
    case 'read': return `Reading ${doc}`;
    case 'insert': { const n = lines(input.text); return `Writing in ${doc}: adding ${count(n, 'paragraph', 'paragraphs')}${where(input)}`; }
    case 'replace': return `Editing ${doc}: replacing “${clip(input.find, 30)}” with “${clip(input.replace, 30)}”`;
    case 'style': return `Formatting ${doc}: “${clip(input.find, 30)}”${input.style ? ` as ${input.style}` : ''}${input.bold ? ', bold' : ''}${input.italic ? ', italic' : ''}`;
    case 'table': return `Writing in ${doc}: adding a table of ${count(Array.isArray(input.rows) ? input.rows.length : 0, 'row', 'rows')}${where(input)}`;
    case 'image': return `Writing in ${doc}: adding the picture ${baseName(input.image) || ''}${where(input)}`.trim();
    case 'comment': return `Commenting in ${doc} on “${clip(input.find ?? input.heading, 30)}”`;
    case 'format': return `Formatting ${doc}: ${formatParts(input).join(', ') || 'the layout'}`;
    case 'track': return `${input.on ? 'Turning on' : 'Turning off'} tracked changes in ${doc}`;
    case 'save': return `Saving ${doc}`;
    case 'save_as': return `Saving ${doc} as ${baseName(input.path) || 'a new file'}`;
    case 'show': return `Showing ${doc} in Word`;
    default: return 'Using Word';
  }
}

// What the document or Word said goes to the AI inside this wrapper (a literal wrapper tag inside it is defanged), like text from a page or an app.
const defang = (t) => String(t ?? '').replace(/<(\/?)untrusted_page_content/gi, '\u2039$1untrusted_page_content');
const wrap = (text, name) => `<untrusted_page_content source="word: ${defang(String(name || 'document')).replace(/["<>]/g, '')}">\n${defang(text)}\n</untrusted_page_content>`;

const OFF_TEXT = 'Using Microsoft Word is off. The user can turn it on in Settings → AI → "Let the AI use Microsoft Word".';
const NO_WORD = 'Microsoft Word is not installed on this computer, so it cannot be driven. Documents can still be read (action read with path to a .docx file), and a .docx file can get new paragraphs, headings and tables written straight into it (insert or table with path), without Word.';
const NOT_WINDOWS = 'Using Word works on Windows for now. On this computer a .docx file can still be read (action read with path) and given new paragraphs, headings and tables (insert or table with path).';

module.exports = { ACTIONS, EDITS, SAVES, ACTING, STYLES, MAX, WordError, validate, checkPath, sameDoc, kind, stepLabel, wrap, defang, baseName, clip, OFF_TEXT, NO_WORD, NOT_WINDOWS, OPEN_EXT };
