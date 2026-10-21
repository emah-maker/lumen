// [desktop apps] What read_app hands the AI: the UI Automation tree of one window, cut down to what it needs. The helper (uia-helper.ps1)
// returns every control it walked as nested nodes; this turns them into a short indented outline of names, kinds, values and element
// ids, never more than a fixed size. Pure functions of their inputs: test/units/desktop-units.js runs them in plain Node.
//
// Node shape from the helper: { i: 'e12'|null, t: 'Button', n: name, v: value, a: automationId, en: false if disabled, off: true if
// offscreen, pw: true for a password field, k: true if checked/toggled, s: true if selected, x: true if expanded, ro: true if
// read-only, p: 'i'|'v'|'t'|'s'|'e' pattern letters, c: [children] }.
//
// Password fields: the node is dropped with all of its children, its value is never copied anywhere, and the reader says only how many
// were left out. Nothing about them reaches the model but that count.
'use strict';

const MAX_NODES = 120; // (was 160)
const MAX_CHARS = 5000; // (was 7000)
const MAX_NAME = 90;
const MAX_VALUE = 160;

// Plain layout: with no name and no value they add depth and nothing else, so their children move up.
const LAYOUT = new Set(['Pane', 'Group', 'Custom', 'Window', 'Header', 'HeaderItem', 'DataItem', 'ListItemContainer', 'Table', 'Tab', 'List', 'Tree', 'Document', 'Image', 'Text', 'ToolBar', 'MenuBar', 'StatusBar', 'Menu', 'TabItem', 'ListItem', 'TreeItem', 'MenuItem', 'DataGrid', 'ComboBox', 'Hyperlink']);
const ALWAYS_LAYOUT = new Set(['Pane', 'Group', 'Custom', 'Window', 'Header', 'ListItemContainer']);
// Never shown: scrolling and window chrome noise.
const SKIP = new Set(['ScrollBar', 'Thumb', 'Separator', 'TitleBar', 'Tooltip', 'Calendar']);
const INTERACTIVE = new Set(['Button', 'CheckBox', 'ComboBox', 'Edit', 'Hyperlink', 'ListItem', 'MenuItem', 'RadioButton', 'Slider', 'Spinner', 'SplitButton', 'TabItem', 'TreeItem', 'Document', 'DataItem']);

const clip = (text, max) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const kindOf = (t) => String(t || '').replace(/^ControlType\./, '') || 'Element';

// Counts the password fields inside `node` (itself included), without reading anything else of them.
function countPasswords(node) {
  if (!node || typeof node !== 'object') return 0;
  if (node.pw === true) return 1;
  let n = 0;
  for (const child of Array.isArray(node.c) ? node.c : []) n += countPasswords(child);
  return n;
}

// prune(root, { maxNodes, maxChars }) -> { lines: string[], shown, omitted: { passwords, offscreen, more }, ids: string[] }
function prune(root, { maxNodes = MAX_NODES, maxChars = MAX_CHARS } = {}) {
  const lines = [];
  const ids = [];
  const omitted = { passwords: 0, offscreen: 0, more: 0 };
  let chars = 0;
  let shown = 0;
  let full = false;

  const visit = (node, depth, parentName = '') => {
    if (!node || typeof node !== 'object') return;
    if (node.pw === true) { omitted.passwords += 1; return; } // a password field: gone, with everything under it
    const kind = kindOf(node.t);
    if (SKIP.has(kind)) return;
    const children = Array.isArray(node.c) ? node.c : [];
    if (node.off === true && depth > 0) { omitted.offscreen += 1; omitted.passwords += countPasswords({ c: children }); return; }
    const name = clip(node.n, MAX_NAME);
    const value = node.v === undefined || node.v === null ? '' : clip(node.v, MAX_VALUE);
    if (kind === 'Text' && name && name === parentName && !value) return; // a button's own label, said twice
    const hasContent = Boolean(name || value || node.i);
    const hoist = ALWAYS_LAYOUT.has(kind) ? !name && !value : LAYOUT.has(kind) && !hasContent;
    if (hoist || !hasContent) {
      for (const child of children) visit(child, depth, parentName);
      return;
    }
    if (full) { omitted.more += 1; omitted.passwords += countPasswords({ c: children }); for (const c of children) omitted.more += count(c); return; }
    const flags = [];
    if (node.en === false) flags.push('disabled');
    if (node.k === true) flags.push('checked');
    if (node.s === true) flags.push('selected');
    if (node.x === true) flags.push('expanded');
    if (node.ro === true && kind === 'Edit') flags.push('read-only');
    const line = `${'  '.repeat(Math.min(depth, 8))}${node.i ? `[${node.i}] ` : ''}${kind}${name ? ` "${name}"` : ''}${value && value !== name ? ` = "${value}"` : ''}${flags.length ? ` (${flags.join(', ')})` : ''}`;
    if (shown >= maxNodes || chars + line.length > maxChars) { full = true; omitted.more += 1 + children.reduce((a, c) => a + count(c), 0); omitted.passwords += countPasswords({ c: children }); return; }
    lines.push(line);
    chars += line.length + 1;
    shown += 1;
    if (node.i) ids.push(node.i);
    for (const child of children) visit(child, depth + 1, name);
  };
  const count = (node) => (node && typeof node === 'object' ? 1 + (Array.isArray(node.c) ? node.c.reduce((a, c) => a + count(c), 0) : 0) : 0);

  visit(root, 0);
  return { lines, shown, omitted, ids };
}

// The text read_app returns, wrapped by the caller as untrusted content (an app's text can say anything).
function render(win, root, opts) {
  const { lines, omitted } = prune(root, opts);
  const head = `Window "${clip(win?.title, 120)}" (${win?.name || win?.proc || 'app'})`;
  const notes = [];
  if (omitted.passwords) notes.push(`${omitted.passwords} password field${omitted.passwords === 1 ? '' : 's'} left out: the AI never reads or fills those`);
  if (omitted.offscreen) notes.push(`${omitted.offscreen} item${omitted.offscreen === 1 ? '' : 's'} scrolled out of view`);
  if (omitted.more) notes.push(`${omitted.more} more not shown: use focus, scroll or a keyboard shortcut and read again`);
  return `${head}\n${lines.join('\n') || '(nothing readable in this window)'}${notes.length ? `\n(${notes.join('; ')})` : ''}`.trim();
}

module.exports = { prune, render, countPasswords, clip, kindOf, MAX_NODES, MAX_CHARS, INTERACTIVE };
