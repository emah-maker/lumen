// [word] What the "word" tool accepts, in plain functions (no Electron, no Word): the action list, the checks every argument goes through,
// what an action costs in trust (read / edit / save), the readable step labels and the wrapper document text travels in.
// Loaded on first use of the tool, never at startup. Nothing in here ever builds code from a value: arguments leave as JSON data.
'use strict';

const path = require('path');

const ACTIONS = ['list', 'open', 'new', 'read', 'insert', 'replace', 'style', 'table', 'image', 'comment', 'track', 'save', 'save_as', 'show'];
// Changes that open, edit, save or show something: refused in hands-off mode and asked about in a card.
const EDITS = new Set(['insert', 'replace', 'style', 'table', 'image', 'comment', 'track']);
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

// input -> { action, ...clean fields } or a WordError with a plain sentence for the AI.
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Give an action.');
  const action = input.action;
  if (!ACTIONS.includes(action)) fail(`action must be one of: ${ACTIONS.join(', ')}.`);
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
      out.replace = input.replace === undefined || input.replace === null ? '' : str(input.replace, 'replace', MAX.text) ?? '';
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

const OFF_TEXT = 'Using Microsoft Word is off. The user can turn it on in Settings → AI and agents → "Let the AI use Microsoft Word".';
const NO_WORD = 'Microsoft Word is not installed on this computer, so it cannot be driven. Documents can still be read (action read with path to a .docx file), and a .docx file can get new paragraphs, headings and tables written straight into it (insert or table with path), without Word.';
const NOT_WINDOWS = 'Using Word works on Windows for now. On this computer a .docx file can still be read (action read with path) and given new paragraphs, headings and tables (insert or table with path).';

module.exports = { ACTIONS, EDITS, SAVES, ACTING, STYLES, MAX, WordError, validate, checkPath, kind, stepLabel, wrap, defang, baseName, clip, OFF_TEXT, NO_WORD, NOT_WINDOWS, OPEN_EXT };
