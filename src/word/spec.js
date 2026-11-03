// [word] What the "word" tool accepts, in plain functions (no Electron, no Word): the action list, the checks every argument goes through,
// what an action costs in trust (read / edit / save), the readable step labels and the wrapper document text travels in.
// Loaded on first use of the tool, never at startup. Nothing in here ever builds code from a value: arguments leave as JSON data.
'use strict';

const path = require('path');

const ACTIONS = ['list', 'open', 'new', 'read', 'insert', 'replace', 'style', 'format', 'table', 'image', 'comment', 'track', 'save', 'save_as', 'show', 'help'];
// Changes that open, edit, save or show something: refused in hands-off mode and asked about in a card.
const EDITS = new Set(['insert', 'replace', 'style', 'format', 'table', 'image', 'comment', 'track']);
const SAVES = new Set(['save', 'save_as']);
const ACTING = new Set(['open', 'new', 'show', ...EDITS, ...SAVES]);
const STYLES = { normal: 'Normal', 'heading 1': 'Heading 1', 'heading 2': 'Heading 2', 'heading 3': 'Heading 3', 'heading 4': 'Heading 4', 'heading 5': 'Heading 5', 'heading 6': 'Heading 6', title: 'Title', 'list bullet': 'List Bullet', bullet: 'List Bullet', bullets: 'List Bullet', 'list number': 'List Number', numbered: 'List Number', number: 'List Number', quote: 'Quote' };
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

// A style by name: one of the built-in ones (case and spacing free), or the document's own ("Lab Caption"), which Word or the file route looks up
// (and says so when the document has no such style). A name that could not be a style's is refused here.
function styleName(v, what = 'style') {
  if (v === undefined || v === null || v === '') return undefined;
  const name = String(v).trim().replace(/\s+/g, ' ');
  const key = name.toLowerCase();
  if (STYLES[key]) return STYLES[key];
  if (name.length > 60 || !/^[\p{L}\p{N} ._'&()+-]+$/u.test(name)) fail(`Unknown ${what} "${String(v).slice(0, 40)}". Use Normal, Heading 1 to 6, Title, List Bullet, List Number, Quote, or a style the document has (make one with format: style and based_on).`);
  return name;
}

// Character formatting (insert, style and format take it): -> fields on out.
const COLORS = { black: '000000', white: 'FFFFFF', red: 'FF0000', 'dark red': 'C00000', orange: 'FFC000', yellow: 'FFFF00', green: '00B050', 'dark green': '006400', blue: '0070C0', 'dark blue': '002060', 'light blue': '00B0F0', purple: '7030A0', gray: '808080', grey: '808080', 'light gray': 'D9D9D9', 'light grey': 'D9D9D9', lightgray: 'D9D9D9', 'pale blue': 'D9E2F3', auto: 'auto' };
const HIGHLIGHTS = ['yellow', 'green', 'cyan', 'magenta', 'blue', 'red', 'darkBlue', 'darkCyan', 'darkGreen', 'darkMagenta', 'darkRed', 'darkYellow', 'darkGray', 'lightGray', 'black', 'white', 'none'];
const UNDERLINES = ['single', 'double', 'thick', 'dotted', 'dash', 'wave', 'words', 'none'];
const bool = (v, name) => { if (v === 'true' || v === 'false') return v === 'true'; if (typeof v !== 'boolean') fail(`${name} must be true or false.`); return v; };
function fontOf(v) { const font = str(v, 'font', 60, { required: true }).trim(); if (!/^[\p{L}\p{N} .'&()-]+$/u.test(font)) fail('font must be a font name, such as Calibri or Times New Roman.'); return font; }
function charOf(input, out) {
  if (input.font !== undefined) out.font = fontOf(input.font);
  if (input.size !== undefined) out.size = Math.round(num(input.size, 'size (points)', 1, 400) * 2) / 2;
  if (input.bold !== undefined) out.bold = bool(input.bold, 'bold');
  if (input.italic !== undefined) out.italic = bool(input.italic, 'italic');
  if (input.strike !== undefined) out.strike = bool(input.strike, 'strike');
  if (input.underline !== undefined) {
    const u = input.underline === true ? 'single' : input.underline === false ? 'none' : String(input.underline).trim().toLowerCase().replace(/^wavy$/, 'wave');
    if (!UNDERLINES.includes(u)) fail(`underline must be true, false or one of ${UNDERLINES.join(', ')}.`);
    out.underline = u;
  }
  if (input.color !== undefined) {
    const c = String(input.color).trim().toLowerCase();
    const hex = COLORS[c] || (/^#?[0-9a-f]{6}$/.test(c) ? c.replace('#', '').toUpperCase() : null);
    if (!hex) fail(`color must be a color name (${Object.keys(COLORS).slice(0, 12).join(', ')}) or #RRGGBB.`);
    out.color = hex;
  }
  if (input.highlight !== undefined) {
    const h = input.highlight === false ? 'none' : String(input.highlight).trim().replace(/\s+(\w)/g, (_, x) => x.toUpperCase()).replace(/^gr[ae]y$/i, 'lightGray');
    const hit = HIGHLIGHTS.find((x) => x.toLowerCase() === h.toLowerCase());
    if (!hit) fail(`highlight must be one of ${HIGHLIGHTS.join(', ')}.`);
    out.highlight = hit;
  }
  return out;
}
const CHAR_KEYS = ['font', 'size', 'bold', 'italic', 'strike', 'underline', 'color', 'highlight'];
const PARA_KEYS = ['line', 'before', 'after', 'align', 'indent', 'firstLine', 'keepNext'];
const hasAny = (o, keys) => keys.some((k) => o[k] !== undefined);

// List items in inserted text: with a list style, each line's indent (a tab or two spaces) is its level, and a typed marker ("- ", "1. ") goes.
const MARKER = /^(?:[-*•‣◦▪]|\d{1,3}[.)]|[a-zA-Z][.)]|[ivxIVX]{1,4}[.)])\s+/;
function listLines(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  const levels = [];
  const out = lines.map((l) => {
    const lead = /^[ \t]*/.exec(l)[0];
    const level = Math.min(9, 1 + (lead.match(/\t/g) || []).length + Math.floor(lead.replace(/\t/g, '').length / 2));
    levels.push(level);
    return l.slice(lead.length).replace(MARKER, '');
  });
  return { text: out.join('\n'), levels: levels.some((n) => n > 1) ? levels : null };
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

// table: a new one (rows, with its look), or one that is there (index: its number in the document, or find: text in one of its cells), whose
// cells, rows, columns and look change. -> the clean fields (as docx.tableDocx and host.ps1 take them).
const BORDERS = ['all', 'outside', 'none'];
const whole = (v, name, lo, hi) => { const n = num(v, name, lo, hi); if (!Number.isInteger(n)) fail(`${name} must be a whole number from ${lo} to ${hi}.`); return n; };
function tableOf(input, out) {
  if (input.header !== undefined) out.header = bool(input.header, 'header');
  if (input.widths !== undefined) {
    if (!Array.isArray(input.widths) || !input.widths.length || input.widths.length > MAX.cols) fail('widths must be a list of column widths in inches, such as [1.5, 3, 1].');
    out.widths = input.widths.map((w) => num(w, 'each of widths (inches)', 0.2, 20));
  }
  if (input.borders !== undefined) { out.borders = String(input.borders).trim().toLowerCase(); if (out.borders === 'grid' || out.borders === 'true') out.borders = 'all'; if (!BORDERS.includes(out.borders)) fail('borders must be all, outside or none.'); }
  if (input.shading !== undefined) { const c = charOf({ color: input.shading }, {}); if (c.color === 'auto') fail('shading must be a color (the header row\'s fill), such as lightgray or #D9E2F3.'); out.shading = c.color; }
  if (input.align !== undefined) { out.align = ALIGN[String(input.align).trim().toLowerCase()]; if (!['left', 'center', 'right'].includes(out.align)) fail('align (for a table) must be left, center or right.'); }
  const edit = input.index !== undefined || (input.find !== undefined && input.find !== '');
  if (!edit) {
    for (const k of ['cells', 'add_rows', 'add_column']) if (input[k] !== undefined) fail(`${k} changes a table that is there: give index (its number, 1 is the first table) or find (text in one of its cells).`);
    Object.assign(out, placeOf(input));
    out.rows = tableRows(input.rows);
    captionOf(input, out);
    if (out.widths && out.widths.length !== out.rows[0].length) fail(`widths has ${out.widths.length} columns but the table has ${out.rows[0].length}.`);
    return out;
  }
  if (input.index !== undefined) out.index = whole(input.index, 'index (the table\'s number, 1 is the first)', 1, 1000);
  else out.find = str(input.find, 'find', MAX.find);
  if (input.caption !== undefined) fail('caption goes on a new table (with rows).');
  if (input.at !== undefined || input.heading !== undefined) fail('at and heading place a new table; a table that is there is picked by index or find.');
  if (input.cells !== undefined) {
    if (!Array.isArray(input.cells) || !input.cells.length || input.cells.length > 500) fail('cells must be a list of [row, column, "text"] (1 is the first row and column).');
    out.cells = input.cells.map((c) => {
      if (!Array.isArray(c) || c.length !== 3) fail('Each of cells is [row, column, "text"], such as [2, 3, "12.5"].');
      const t = c[2] === null || c[2] === undefined ? '' : String(c[2]);
      if (t.length > MAX.cell) fail(`A table cell can hold at most ${MAX.cell} characters.`);
      return [whole(c[0], 'a cell\'s row', 1, MAX.rows * 5), whole(c[1], 'a cell\'s column', 1, MAX.cols), t];
    });
  }
  if (input.add_rows !== undefined) {
    out.addRows = input.add_rows === 'end' ? -1 : whole(input.add_rows, 'add_rows (the row to add after: 0 is the top, "end" the bottom)', 0, MAX.rows * 5);
    out.rows = input.rows === undefined ? [['']] : tableRows(input.rows);
  } else if (input.rows !== undefined) fail('rows on a table that is there go with add_rows (the row to add them after: 0 is the top, "end" the bottom); cells changes cells.');
  if (input.add_column !== undefined) out.addColumn = input.add_column === 'end' ? -1 : whole(input.add_column, 'add_column (the column to add after: 0 is the first, "end" the last)', 0, MAX.cols);
  if (!out.cells && out.addRows === undefined && out.addColumn === undefined && !['header', 'widths', 'borders', 'shading', 'align'].some((k) => out[k] !== undefined)) fail('Give what changes in the table: cells, add_rows (with rows), add_column, header, widths, borders, shading or align.');
  return out;
}

// format, pages: a header and a footer ("left | center | right", with {page}, {pages} and {date} as fields), page numbers, a different first
// page, page numbering that starts at n, columns, and section and column breaks before paragraphs.
const POS = ['left', 'center', 'right'];
function hfOf(v, name) {
  const t = str(v, name, 300) ?? '';
  const parts = t.split(/\s*\|\s*/);
  if (parts.length > 3) fail(`${name} has at most three parts: "left | center | right".`);
  if (/\{(?!page\}|pages\}|date\})[^}]*\}/i.test(t)) fail(`${name} knows {page}, {pages} and {date}; other {...} are not fields.`);
  return parts.length === 1 ? { center: parts[0] } : parts.length === 2 ? { left: parts[0], right: parts[1] } : { left: parts[0], center: parts[1], right: parts[2] };
}
function pagesOf(input, out) {
  if (input.header !== undefined) out.header = hfOf(input.header, 'header');
  if (input.footer !== undefined) out.footer = hfOf(input.footer, 'footer');
  if (input.page_numbers !== undefined) {
    const p = input.page_numbers === true ? 'bottom center' : String(input.page_numbers).trim().toLowerCase().replace(/[-_]+/g, ' ');
    const words = p.replace(/centre/g, 'center').split(/\s+/);
    const m = [null, words.find((w) => w === 'top' || w === 'bottom'), words.find((w) => POS.includes(w))];
    if (!m[1] || words.some((w) => !['top', 'bottom', ...POS].includes(w))) fail('page_numbers must be true, or where they go: bottom center, bottom right, top right... (or write footer: "Page {page} of {pages}").');
    const where = m[1] === 'top' ? 'header' : 'footer';
    if (out[where]) fail(`page_numbers goes in the ${where}, which this call also sets: put {page} in ${where} instead.`);
    out[where] = { [m[2] || 'center']: '{page}' };
  }
  if (input.different_first_page !== undefined) out.firstPage = bool(input.different_first_page, 'different_first_page');
  if (input.page_number_start !== undefined) out.pageStart = whole(input.page_number_start, 'page_number_start', 0, 9999);
  if (input.columns !== undefined) out.columns = whole(input.columns, 'columns', 1, 4);
  if (input.section_break_before !== undefined) out.sectionBreaks = texts(input.section_break_before, 'section_break_before');
  if (input.section_break !== undefined) {
    out.sectionBreak = { 'next page': 'nextPage', next_page: 'nextPage', nextpage: 'nextPage', continuous: 'continuous', 'even page': 'evenPage', even_page: 'evenPage', 'odd page': 'oddPage', odd_page: 'oddPage' }[String(input.section_break).trim().toLowerCase()];
    if (!out.sectionBreak) fail('section_break must be next_page, continuous, even_page or odd_page.');
    if (!out.sectionBreaks) fail('section_break says what kind of break section_break_before makes; give section_break_before too.');
  }
  if (input.column_break_before !== undefined) out.columnBreaks = texts(input.column_break_before, 'column_break_before');
}

// image: how the picture sits in the text.
const WRAPS = { inline: 'inline', in_line: 'inline', in_line_with_text: 'inline', square: 'square', tight: 'tight', through: 'tight', top_bottom: 'top_bottom', top_and_bottom: 'top_bottom', topbottom: 'top_bottom', behind: 'behind', behind_text: 'behind', front: 'front', in_front: 'front', in_front_of_text: 'front' };
// A caption under a picture ("Figure 1: ...") or over a table ("Table 1: ..."): a numbered SEQ field, so the numbers stay right.
function captionOf(input, out) {
  if (input.caption === undefined) return;
  out.caption = str(input.caption, 'caption', 500) ?? '';
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
const ALIGN = { left: 'left', start: 'left', center: 'center', centre: 'center', centered: 'center', right: 'right', end: 'right', justify: 'justify', justified: 'justify', both: 'justify' };
const LISTS = { bullet: 'bullet', bullets: 'bullet', bulleted: 'bullet', number: 'number', numbers: 'number', numbered: 'number', none: 'none', off: 'none', remove: 'none' };
function formatOf(input) {
  const out = {};
  charOf(input, out);
  if (input.line_spacing !== undefined) { out.line = num(input.line_spacing, 'line_spacing', 0.5, 200); if (out.line > 5 && out.line < 6) fail('line_spacing is a multiple of a line (1, 1.15, 1.5, 2; at most 5) or an exact height in points (6 or more).'); }
  if (input.space_before !== undefined) out.before = num(input.space_before, 'space_before (points)', 0, 200);
  if (input.space_after !== undefined) out.after = num(input.space_after, 'space_after (points)', 0, 200);
  if (input.align !== undefined) { out.align = ALIGN[String(input.align).trim().toLowerCase()]; if (!out.align) fail('align must be left, center, right or justify.'); }
  if (input.indent !== undefined) out.indent = num(input.indent, 'indent (inches from the left margin)', 0, 10);
  if (input.first_line !== undefined) out.firstLine = num(input.first_line, 'first_line (inches; negative is a hanging indent)', -10, 10);
  if (input.keep_with_next !== undefined) out.keepNext = bool(input.keep_with_next, 'keep_with_next');
  const style = styleName(input.style); if (style) out.style = style;
  if (input.based_on !== undefined) { if (!out.style) fail('based_on needs style: the name of the style to make or change.'); out.basedOn = styleName(input.based_on, 'based_on style'); }
  const find = str(input.find, 'find', MAX.find); if (find) out.find = find;
  if (input.paragraphs !== undefined) out.paras = texts(input.paragraphs, 'paragraphs');
  if ([out.style, out.find, out.paras].filter(Boolean).length > 1) fail('Give style or find, not both (nor paragraphs with either): style changes a style, find the paragraphs holding that text, paragraphs the paragraphs with those texts.');
  if (input.list !== undefined) {
    out.list = LISTS[String(input.list).trim().toLowerCase()];
    if (!out.list) fail('list must be bullet, number or none.');
    if (!out.find && !out.paras) fail('list needs the paragraphs to make a list of: paragraphs (their texts, as read shows them) or find.');
  }
  if (input.level !== undefined) { if (!out.list || out.list === 'none') fail('level goes with list (bullet or number).'); out.level = num(input.level, 'level', 1, 9); if (!Number.isInteger(out.level)) fail('level must be a whole number from 1 to 9.'); }
  if (input.margins !== undefined) out.margins = marginsOf(input.margins);
  if (input.orientation !== undefined) { if (!['portrait', 'landscape'].includes(input.orientation)) fail('orientation must be portrait or landscape.'); out.orientation = input.orientation; }
  if (input.section !== undefined) { if (!Number.isInteger(input.section) || input.section < 1) fail('section must be a section number (1 is the first).'); out.section = input.section; }
  if (input.page_break_before !== undefined) out.breaks = texts(input.page_break_before, 'page_break_before');
  pagesOf(input, out);
  if (input.headings !== undefined) out.headings = texts(input.headings, 'headings').map((t) => { const m = /^(#{1,6})\s+(.+)$/.exec(t); return m ? { text: m[2].trim(), level: m[1].length } : { text: t, level: 1 }; });
  if (input.toc !== undefined) { if (typeof input.toc !== 'boolean') fail('toc must be true (a table of contents).'); if (input.toc) out.toc = true; }
  const at = str(input.heading, 'heading', MAX.find); if (at) { if (!out.toc) fail('heading (where the table of contents goes) needs toc: true.'); out.tocAt = at; }
  const text = hasAny(out, CHAR_KEYS) || hasAny(out, PARA_KEYS);
  if ((out.style || out.find || out.paras) && !text && !out.list && !out.basedOn) fail('style, find and paragraphs pick where the change goes; give one of those changes: font, size, bold, italic, underline, color, line_spacing, space_before, space_after, align, indent, first_line, keep_with_next (or list, or based_on for a style). help lists them.');
  const page = ['header', 'footer', 'firstPage', 'pageStart', 'columns', 'sectionBreaks', 'columnBreaks'].some((k) => out[k] !== undefined);
  if (!text && !page && !out.list && !out.basedOn && !out.margins && !out.orientation && !out.breaks && !out.headings && !out.toc) fail('Give something to change: font, size, line_spacing, space_before, space_after, align, indent, margins, orientation, page_break_before, headings, list, toc, header, footer, page_numbers, columns or section_break_before (help lists them all).');
  if (out.section && !out.margins && !out.orientation && !['header', 'footer', 'firstPage', 'pageStart', 'columns'].some((k) => out[k] !== undefined)) fail('section picks where margins, orientation, header, footer, page numbers or columns change; give one of those.');
  return out;
}

// What each change takes besides action, doc and path (tab_id: the MCP listing adds it to every tool). An argument it does not take is refused,
// not dropped: a model that sent replace's new text as new_text had the found text replaced with nothing, so its edit deleted what it meant to change.
const BOOKMARK = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const CHAR_ARGS = ['font', 'size', 'bold', 'italic', 'underline', 'color', 'highlight', 'strike'];
const EDIT_ARGS = { insert: ['at', 'heading', 'text', 'style', 'bold', 'italic', 'find', 'note', 'ref'], replace: ['find', 'replace'], style: ['find', 'style', ...CHAR_ARGS, 'link', 'bookmark'], table: ['at', 'heading', 'rows', 'caption', 'header', 'widths', 'borders', 'shading', 'align', 'index', 'find', 'cells', 'add_rows', 'add_column'], image: ['at', 'heading', 'image', 'width', 'height', 'wrap', 'align', 'caption', 'alt'], comment: ['find', 'heading', 'comment', 'text'], track: ['on'], format: [...CHAR_ARGS, 'line_spacing', 'space_before', 'space_after', 'align', 'indent', 'first_line', 'keep_with_next', 'style', 'based_on', 'find', 'paragraphs', 'list', 'level', 'margins', 'orientation', 'section', 'page_break_before', 'toc', 'heading', 'headings', 'header', 'footer', 'page_numbers', 'different_first_page', 'page_number_start', 'columns', 'section_break_before', 'section_break', 'column_break_before'] };
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
    case 'help': { const t = input.topic ?? input.find; if (t !== undefined && t !== '') out.topic = String(t).slice(0, 40).trim().toLowerCase(); break; }
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
      if (input.find !== undefined && input.find !== '') {
        // in the text: right after the first place find matches, as text, a footnote or endnote, or a cross-reference
        if (input.at !== undefined || input.heading !== undefined || input.style !== undefined) fail('find puts the insert inside a paragraph, right after that text; at, heading and style place new paragraphs. Give one or the other.');
        out.find = str(input.find, 'find', MAX.find);
        if (input.note !== undefined) { out.note = { footnote: 'footnote', endnote: 'endnote' }[String(input.note).trim().toLowerCase()]; if (!out.note) fail('note must be footnote or endnote.'); }
        if (input.ref !== undefined) {
          out.ref = str(input.ref, 'ref', 60, { required: true }).trim();
          if (out.note) fail('Give note or ref, not both.');
          if (!/^(figure|table) \d{1,4}$/i.test(out.ref) && !BOOKMARK.test(out.ref)) fail('ref is "Figure 2", "Table 1" (a caption) or a bookmark\'s name (made with style: find, bookmark).');
          if (input.text !== undefined) out.text = str(input.text, 'text', 200);
          break;
        }
        out.text = str(input.text, 'text', out.note ? 4000 : MAX.text, { required: true });
        if (!out.note && /[\r\n]/.test(out.text)) fail('Text put inside a paragraph (with find) is one line; insert with at or heading adds paragraphs.');
        break;
      }
      if (input.note !== undefined || input.ref !== undefined) fail('note and ref go with find: the text the note mark or the cross-reference goes right after.');
      Object.assign(out, placeOf(input));
      out.text = str(input.text, 'text', MAX.text, { required: true });
      const style = styleName(input.style); if (style) out.style = style;
      if (/^List (Bullet|Number)$/.test(out.style || '')) { const l = listLines(out.text); out.text = l.text; if (l.levels) out.levels = l.levels; }
      if (input.bold !== undefined) out.bold = bool(input.bold, 'bold');
      if (input.italic !== undefined) out.italic = bool(input.italic, 'italic');
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
      if (pathArg !== undefined && pathArg !== '') out.path = checkPath(pathArg);
      out.find = str(input.find, 'find', MAX.find, { required: true });
      const style = styleName(input.style); if (style) out.style = style;
      charOf(input, out);
      if (input.link !== undefined) {
        const l = str(input.link, 'link', 2000, { required: true }).trim();
        if (l.startsWith('#')) { if (!BOOKMARK.test(l.slice(1))) fail('link "#name" goes to a bookmark: letters, digits and _, starting with a letter.'); out.link = l; } else {
          let u; try { u = new URL(l); } catch { fail('link must be a web address (https://...), mailto:, or #bookmark.'); }
          if (!['https:', 'http:', 'mailto:'].includes(u.protocol)) fail('link must be a web address (https://...), mailto:, or #bookmark.');
          out.link = u.href;
        }
      }
      if (input.bookmark !== undefined) { out.bookmark = str(input.bookmark, 'bookmark', 40, { required: true }).trim(); if (!BOOKMARK.test(out.bookmark)) fail('bookmark is a name of letters, digits and _, starting with a letter (at most 40), such as Results or Fig_setup.'); }
      if (!out.style && !hasAny(out, CHAR_KEYS) && !out.link && !out.bookmark) fail('Give a style, bold or italic to apply (or font, size, underline, color, highlight, strike, link, bookmark).');
      break;
    }
    case 'format': if (pathArg !== undefined && pathArg !== '') out.path = checkPath(pathArg); Object.assign(out, formatOf(input)); break;
    case 'table': {
      if (pathArg !== undefined && pathArg !== '') out.path = checkPath(pathArg);
      tableOf(input, out);
      break;
    }
    case 'image': {
      if (pathArg !== undefined && pathArg !== '') out.path = checkPath(pathArg);
      Object.assign(out, placeOf(input));
      const src = typeof input.image === 'string' ? input.image.trim() : '';
      if (/^https?:\/\//i.test(src)) { if (src.length > 2000) fail('That picture address is too long.'); out.url = src; } else { out.image = checkPath(input.image, 'image path (or an https address)'); if (!IMAGE_EXT.test(out.image)) fail('Only .png, .jpg, .gif and .bmp pictures are inserted.'); }
      if (input.width !== undefined) out.width = num(input.width, 'width (inches)', 0.1, 22);
      if (input.height !== undefined) out.height = num(input.height, 'height (inches)', 0.1, 30);
      if (input.wrap !== undefined) { out.wrap = WRAPS[String(input.wrap).trim().toLowerCase().replace(/[\s-]+/g, '_')]; if (!out.wrap) fail('wrap must be inline, square, tight, top_bottom, behind or front.'); }
      if (input.align !== undefined) { out.align = ALIGN[String(input.align).trim().toLowerCase()]; if (!['left', 'center', 'right'].includes(out.align)) fail('align (for a picture) must be left, center or right.'); }
      captionOf(input, out);
      if (input.alt !== undefined) out.alt = str(input.alt, 'alt', 500);
      break;
    }
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
  for (const k of ['bold', 'italic', 'strike']) if (i[k] === true) parts.push(k);
  if (i.underline && i.underline !== 'none' && i.underline !== false) parts.push('underline');
  if (i.color) parts.push(`color ${clip(i.color, 12)}`);
  if (i.highlight && i.highlight !== 'none') parts.push(`${clip(i.highlight, 12)} highlight`);
  if (i.link) parts.push('a link');
  if (i.bookmark) parts.push(`bookmark ${clip(i.bookmark, 30)}`);
  if (i.align) parts.push(`${clip(i.align, 10)} aligned`);
  if (i.indent !== undefined || (i.first_line ?? i.firstLine) !== undefined) parts.push('indents');
  if (i.list) parts.push(i.list === 'none' || i.list === 'off' ? 'no list' : /^bullet/.test(i.list) ? 'a bulleted list' : 'a numbered list');
  if (i.based_on ?? i.basedOn) parts.push(`style ${clip(i.style, 30)} based on ${clip(i.based_on ?? i.basedOn, 30)}`);
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
    case 'insert': if (input.find) return input.ref ? `Writing in ${doc}: a cross-reference to ${clip(input.ref, 30)} after “${clip(input.find, 30)}”` : input.note ? `Writing in ${doc}: a${input.note === 'endnote' ? 'n endnote' : ' footnote'} after “${clip(input.find, 30)}”` : `Writing in ${doc}: text after “${clip(input.find, 30)}”`;
      { const n = lines(input.text); return `Writing in ${doc}: adding ${count(n, 'paragraph', 'paragraphs')}${where(input)}`; }
    case 'replace': return `Editing ${doc}: replacing “${clip(input.find, 30)}” with “${clip(input.replace, 30)}”`;
    case 'style': { const extra = formatParts({ ...input, style: undefined, based_on: undefined }); return `Formatting ${doc}: “${clip(input.find, 30)}”${input.style ? ` as ${input.style}` : ''}${extra.length ? `, ${extra.join(', ')}` : ''}`; }
    case 'table': if (input.index !== undefined || input.find) return `Editing ${doc}: ${input.index !== undefined ? `table ${clip(input.index, 6)}` : `the table with “${clip(input.find, 30)}”`}${Array.isArray(input.cells) ? `, ${count(input.cells.length, 'cell', 'cells')}` : ''}${input.add_rows !== undefined ? `, adding ${count(Array.isArray(input.rows) ? input.rows.length : 1, 'row', 'rows')}` : ''}${input.add_column !== undefined ? ', adding a column' : ''}`;
      return `Writing in ${doc}: adding a table of ${count(Array.isArray(input.rows) ? input.rows.length : 0, 'row', 'rows')}${where(input)}`;
    case 'image': { const src = String(input.image || ''); const name = /^https?:/i.test(src) ? (() => { try { return `from ${new URL(src).hostname}`; } catch { return ''; } })() : baseName(src); return `Writing in ${doc}: adding the picture ${name || ''}${input.caption ? ` with the caption “${clip(input.caption, 30)}”` : ''}${where(input)}`.trim(); }
    case 'comment': return `Commenting in ${doc} on “${clip(input.find ?? input.heading, 30)}”`;
    case 'format': return `Formatting ${doc}: ${formatParts(input).join(', ') || 'the layout'}`;
    case 'track': return `${input.on ? 'Turning on' : 'Turning off'} tracked changes in ${doc}`;
    case 'save': return `Saving ${doc}`;
    case 'save_as': return `Saving ${doc} as ${baseName(input.path) || 'a new file'}`;
    case 'show': return `Showing ${doc} in Word`;
    case 'help': return 'Looking up what the Word tool takes';
    default: return 'Using Word';
  }
}

// What the document or Word said goes to the AI inside this wrapper (a literal wrapper tag inside it is defanged), like text from a page or an app.
const defang = (t) => String(t ?? '').replace(/<(\/?)untrusted_page_content/gi, '\u2039$1untrusted_page_content');
const wrap = (text, name) => `<untrusted_page_content source="word: ${defang(String(name || 'document')).replace(/["<>]/g, '')}">\n${defang(text)}\n</untrusted_page_content>`;

// help: every action's fields, so the tool's own description can stay short. topic: an action name, or a word from a line (lists, styles, page).
const HELP = [
  'word tool, every field (doc: an open document by name or path, default the active one; path: a .docx file, worked on without Word when Word does not have it open):',
  'read: offset (next_offset of the last read). Headings show as #, lists as -, tables as | a | b |.',
  'insert: text (a line per paragraph), at end|start|after|section_end, heading (the paragraph to go after), style, bold, italic. Lists: style "List Bullet" or "List Number"; indent a line (two spaces or a tab) for a deeper level; a typed "- " or "1. " is dropped.',
  'insert in the text (references): find (the text it goes right after), then text (a word or sentence), or note footnote|endnote with text (the note), or ref "Figure 2" / "Table 1" / a bookmark name (a cross-reference Word keeps up to date).',
  'replace: find, replace (required; "" deletes). A line break in find matches across paragraphs.',
  'style (the exact text found): find, and style (any style the document has: Normal, Heading 1-6, Title, Quote, List Bullet, List Number, or its own) or character formatting: bold, italic, underline (true or single|double|thick|dotted|dash|wave|none), color (red, blue, #1F4E79...), highlight (yellow, green, cyan, lightGray, none...), strike, font, size; link (https://..., mailto:, or #bookmark) makes it a hyperlink; bookmark (a name) marks it for ref and #links.',
  'format (styles, paragraphs and pages; where: style (that style everywhere, the cleanest), find (paragraphs holding that text), paragraphs [their texts], or nothing for the whole document): font, size, bold, italic, underline, color, line_spacing (1, 1.15, 1.5, 2; 6+ = exact points), space_before / space_after (points), align left|center|right|justify, indent (inches), first_line (inches; negative = hanging), keep_with_next.',
  'format styles: style + based_on makes the style when the document has none of that name (style "Figure Caption", based_on "Normal", size 9, italic true), or changes what it is based on; then apply it with style or insert.',
  'format lists: list bullet|number|none with paragraphs or find, level 1-9 (a numbered list starts at 1 each time).',
  'format pages: margins (normal|narrow|moderate|wide or inches "1" / "1 1.25" / "1 1 1 1"), orientation portrait|landscape, section (number) for one section only, page_break_before [paragraph texts], headings ["# Title", "## Sub"] (Heading 1-6), toc true (a real table of contents; heading: the paragraph to put it after).',
  'format headers and footers: header / footer "text" or "left | center | right" with {page}, {pages}, {date} (footer "Page {page} of {pages}"), page_numbers true or bottom center|bottom right|top right..., different_first_page (a title page without them), page_number_start, columns 1-4; section (number) for one section only; section_break_before [paragraph texts] with section_break next_page|continuous|even_page|odd_page, column_break_before [paragraph texts].',
  'table (new): rows [[cells]], at, heading, header (first row repeats on each page, bold; default true), widths [inches per column], borders all|outside|none, shading (the header row\'s fill: lightgray, #D9E2F3...), align left|center|right.',
  'table (one that is there): index (1 is the first table, in reading order) or find (text in one of its cells), then cells [[row, col, "text"]] (1-based, counted after the rows and column this call adds), add_rows (after row n: 0 top, "end" bottom) with rows [[cells]], add_column (after column n, "end"; fill it with cells), header, widths, borders, shading, align.',
  'image: image (a file path or an https address), at, heading, width / height (inches; one keeps the shape), wrap inline|square|tight|top_bottom|behind|front, align left|center|right, caption ("Figure N: " is added, numbered by Word), alt (text for screen readers). table (new) takes caption too ("Table N: ", above it).',
  'comment: find, comment. track: on. save; save_as: path (.docx or .pdf). show.',
];
function help(topic) {
  const t = String(topic || '').toLowerCase();
  const lines = t ? HELP.filter((l, i) => i === 0 || l.toLowerCase().startsWith(t) || l.toLowerCase().includes(` ${t}`)) : HELP;
  return (lines.length > 1 ? lines : HELP).join(String.fromCharCode(10));
}

const OFF_TEXT = 'Using Microsoft Word is off. The user can turn it on in Settings → AI → "Let the AI use Microsoft Word".';
const NO_WORD = 'Microsoft Word is not installed on this computer, so it cannot be driven. Documents can still be read (action read with path to a .docx file), and a .docx file can get new paragraphs, headings and tables written straight into it (insert or table with path), without Word.';
const NOT_WINDOWS = 'Using Word works on Windows for now. On this computer a .docx file can still be read (action read with path) and given new paragraphs, headings and tables (insert or table with path).';

module.exports = { help, listLines, ACTIONS, EDITS, SAVES, ACTING, STYLES, MAX, WordError, validate, checkPath, sameDoc, kind, stepLabel, wrap, defang, baseName, clip, OFF_TEXT, NO_WORD, NOT_WINDOWS, OPEN_EXT };
