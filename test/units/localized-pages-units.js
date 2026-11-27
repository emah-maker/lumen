// The error, History, Bookmarks, Downloads, Reading list and Reader pages, and Settings' rows, take every word a person reads
// from locales/en.json (t() / tr() / data-i18n). This scans their sources for English that was typed in directly, so it
// can't creep back: a string literal that reads as a phrase, outside a t()/tr()/fill() call, in a page script; text in a page's
// HTML that has no data-i18n (and isn't an element the page's script fills in); and a Settings row helper (row, toggle,
// select, ...) handed a plain English label or description. Plain Node, no window.
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const EN = JSON.parse(read('src/locales/en.json'));

// ---- helpers
const PAGES = ['history', 'bookmarks', 'downloads', 'downloads-panel', 'readinglist', 'error', 'cert-error', 'https-only', 'safe-browsing', 'unloaded', 'reader'];
const SCRIPTS = [...PAGES, 'error-kinds', 'cert-reasons'];
// calls whose string arguments are keys, selectors or IDs, not words a person reads
const QUIET_CALLEES = new Set(['t', 'tr', 'fill', 'require', 'getElementById', 'querySelector', 'querySelectorAll', 'closest', 'matches', 'addEventListener', 'removeEventListener',
  'setAttribute', 'getAttribute', 'removeAttribute', 'hasAttribute', 'createElement', 'createElementNS', 'contains', 'add', 'remove', 'toggle', 'getPropertyValue', 'setProperty', 'postMessage', 'send', 'sendSync', 'invoke', 'on', 'has', 'get', 'set', 'delete']);
// a literal reads as English when it has two words, or is one capitalised word of 4+ letters (not a key name)
const KEY_NAMES = new Set(['Escape', 'Enter', 'Delete', 'Backspace', 'Space']);
const looksEnglish = (s) => ((/[A-Za-z]{2,} [A-Za-z’']{2,}/.test(s) && !/^[a-z0-9_-]+( [a-z0-9_-]+)*$/.test(s)) || (/^[A-Z][a-z]{3,}$/.test(s) && !KEY_NAMES.has(s))) && !/[<>{};=]|^[./#:[]|^\s*$/.test(s);
const nameOf = (callee) => (callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' && !callee.computed ? callee.property.name : '');

function walk(node, parents, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parents);
  parents.push(node);
  for (const k of Object.keys(node)) { const v = node[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, parents, visit)); else if (v && typeof v.type === 'string') walk(v, parents, visit); }
  parents.pop();
}

// English phrases typed into a page script, outside a translation call
function hardCodedIn(file) {
  const src = read(file);
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, locations: true });
  const found = [];
  walk(ast, [], (node, parents) => {
    let text = null;
    if (node.type === 'Literal' && typeof node.value === 'string') text = node.value;
    else if (node.type === 'TemplateElement') text = node.value.cooked;
    if (text == null || !looksEnglish(text)) return;
    const parent = parents[parents.length - 1];
    if (parent.type === 'Property' && parent.key === node && !parent.computed) return; // an object key
    if (parent.type === 'TemplateLiteral' && parents[parents.length - 2]?.type === 'CallExpression' && QUIET_CALLEES.has(nameOf(parents[parents.length - 2].callee))) return;
    if (parent.type === 'CallExpression' && QUIET_CALLEES.has(nameOf(parent.callee))) return;
    if (parent.type === 'BinaryExpression' || parent.type === 'SwitchCase') return; // a comparison, not shown
    if (parent.type === 'Property' && /^(className|class|id|type|role|rel|href|src|dataset|name|autocomplete|inputMode)$/.test(parent.key.name || parent.key.value)) return;
    // a fallback after a translated value (t('key') || 'English') is still typed-in English
    found.push(`${file}:${node.loc.start.line} ${JSON.stringify(text.slice(0, 50))}`);
  });
  return found;
}

// text in a page's HTML that is neither translated nor filled in by its script
function untranslatedHtml(name) {
  const html = read(`src/renderer/${name}.html`).replace(/<!--[\s\S]*?-->/g, '').replace(/<!doctype[^>]*>/i, '').replace(/<(script|style)[\s\S]*?<\/\1>/g, '');
  const js = (fs.existsSync(path.join(root, `src/renderer/${name}.js`)) ? read(`src/renderer/${name}.js`) : '');
  const found = [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  let m;
  const VOID = new Set(['meta', 'link', 'input', 'br', 'hr', 'img', 'svg', 'path', 'circle']);
  while ((m = re.exec(html))) {
    if (m[2]) {
      const tag = m[2].toLowerCase();
      if (m[1]) { while (stack.length && stack.pop().tag !== tag) { /* unwind */ } continue; }
      const attrs = m[3];
      const self = /\/\s*$/.test(attrs) || VOID.has(tag);
      const entry = { tag, i18n: /\bdata-i18n(?:-[a-z-]+)?=/.test(attrs) && /\bdata-i18n=/.test(attrs), id: /\bid="([^"]+)"/.exec(attrs)?.[1] || '' };
      // visible attributes need their own translation
      for (const a of ['title', 'placeholder', 'aria-label', 'alt']) {
        const v = new RegExp(`\\b${a}="([^"]*)"`).exec(attrs)?.[1];
        if (v && looksEnglish(v) && !new RegExp(`\\bdata-i18n-${a}=`).test(attrs) && !(entry.id && js.includes(`'${entry.id}'`))) found.push(`${name}.html <${tag}> ${a}="${v.slice(0, 40)}"`);
      }
      if (tag === 'title') entry.i18n = true; // the tab title is set by the page script
      if (!self) stack.push(entry);
    } else {
      const text = m[4].replace(/&[a-z#0-9]+;/g, ' ').trim();
      if (!/[A-Za-z]{3,}/.test(text)) continue;
      const covered = stack.some((e) => e.i18n || (e.id && js.includes(`'${e.id}'`)));
      if (!covered) found.push(`${name}.html "${text.slice(0, 50)}"`);
    }
  }
  return found;
}

// ---- 1. page scripts
for (const f of SCRIPTS) {
  const left = hardCodedIn(`src/renderer/${f}.js`);
  check(`${f}.js: no English typed in outside t()`, left.length === 0, left.join(' | '));
}

// ---- 2. page HTML
for (const n of PAGES) {
  const left = untranslatedHtml(n);
  check(`${n}.html: every visible word is translated or filled in by its script`, left.length === 0, left.join(' | '));
}

// ---- 3. Reader: the tab title the main process hands over comes from en.json
check('reader: the untitled tab name is a string in en.json and main hands it over', EN['reader.title'] === 'Reader' && /readerTitle: /.test(read('src/features/page-tools.js')) && /data\.readerTitle/.test(read('src/renderer/reader.js')));

// ---- 4. Settings rows: label and description arguments go through tr()
// helper -> the argument positions that hold a label or a description
const ROW_ARGS = { row: [0, 1], stackRow: [0, 1], toggle: [1, 2], select: [1, 2], collapsible: [0, 2], armedButton: [0, 1], meterRow: [0, 2], infoButton: [0, 1], linkRow: [0] };
const settingsFiles = fs.readdirSync(path.join(root, 'src/renderer')).filter((f) => /^settings(-[a-z-]+)?\.js$/.test(f) && f !== 'settings.bundle.js');
const settingsTexts = [];
for (const f of settingsFiles) {
  const src = read(`src/renderer/${f}`);
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  walk(ast, [], (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return;
    const positions = ROW_ARGS[node.callee.name];
    if (!positions) return;
    const args = positions.map((i) => node.arguments[i]);
    if (node.callee.name === 'linkRow' && node.arguments[1]?.type === 'ObjectExpression') for (const p of node.arguments[1].properties) if (p.key?.name === 'desc') args.push(p.value);
    for (const a of args) {
      if (!a) continue;
      const text = a.type === 'Literal' && typeof a.value === 'string' ? a.value : a.type === 'TemplateLiteral' ? a.quasis.map((q) => q.value.cooked).join('{}') : null;
      if (text != null && /[A-Za-z]{2}/.test(text.replace(/\{\}/g, ''))) settingsTexts.push(`${f}:${a.loc.start.line} ${JSON.stringify(text.slice(0, 50))}`);
    }
  });
}
check('settings: no row label or description is typed in English outside tr()', settingsTexts.length === 0, settingsTexts.slice(0, 12).join(' | ') + (settingsTexts.length > 12 ? ` (+${settingsTexts.length - 12} more)` : ''));

// every tr('key', 'English') in the settings scripts has its key in en.json, with the same English
const drift = [];
for (const f of settingsFiles) {
  const src = read(`src/renderer/${f}`);
  walk(acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true }), [], (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'tr') return;
    const [k, e] = node.arguments;
    if (k?.type !== 'Literal' || typeof k.value !== 'string' || !k.value.startsWith('settings.row.')) return;
    const english = e?.type === 'Literal' ? e.value : e?.type === 'TemplateLiteral' && e.expressions.length === 0 ? e.quasis[0].value.cooked : null;
    if (typeof EN[k.value] !== 'string') drift.push(`${k.value} missing`);
    else if (english != null && english !== EN[k.value]) drift.push(`${k.value} differs`);
  });
}
check('settings: every row string has its key in en.json, with the same English', drift.length === 0, drift.slice(0, 8).join(', '));

process.exit(failures ? 1 : 0);
