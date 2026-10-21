// [desktop apps] macOS: what mac-helper.jxa reads from System Events (accessibility roles such as AXButton, with a path of child indexes from
// the window) turned into the node shape tree.js already prunes and renders for Windows, plus the element ids (e3) the AI passes back to
// click and type. The helper is a new osascript per call and keeps nothing, so the ids live here: each id maps to its path and to the role,
// name and description it had, and an action is refused when the element at that path is no longer the same one. An element with neither a
// name nor a description could not be told from another of its kind at the same place, so it gets no id, unless it is the only one of its
// role in the window (a document's one text area). Pure: test/units/desktop-mac-units.js.
//
// Raw node from the helper: { r: 'AXButton', sr: subrole, n: title or name, d: description, v: value, en: false if disabled,
// sel: true if selected, p: [0, 3, 1], c: [children] } or { pw: true } for a secure text field (nothing else of it is ever read).
'use strict';

const { INTERACTIVE } = require('./tree');

// Accessibility roles -> the UI Automation kinds tree.js knows (its layout, skip and interactive lists then apply as they are).
const KIND = {
  AXWindow: 'Window', AXSheet: 'Window', AXDrawer: 'Pane', AXDialog: 'Window',
  AXButton: 'Button', AXDisclosureTriangle: 'Button', AXMenuButton: 'SplitButton', AXPopUpButton: 'ComboBox', AXComboBox: 'ComboBox',
  AXCheckBox: 'CheckBox', AXRadioButton: 'RadioButton', AXSlider: 'Slider', AXIncrementor: 'Spinner', AXStepper: 'Spinner',
  AXTextField: 'Edit', AXTextArea: 'Edit', AXSearchField: 'Edit', AXStaticText: 'Text', AXHeading: 'Text', AXLink: 'Hyperlink',
  AXImage: 'Image', AXGroup: 'Group', AXScrollArea: 'Pane', AXSplitGroup: 'Pane', AXLayoutArea: 'Pane', AXLayoutItem: 'Group', AXUnknown: 'Custom',
  AXToolbar: 'ToolBar', AXTabGroup: 'Tab', AXRadioGroup: 'Group', AXTable: 'Table', AXOutline: 'Tree', AXBrowser: 'Tree', AXList: 'List',
  AXRow: 'ListItem', AXCell: 'DataItem', AXColumn: 'Header', AXMenuBar: 'MenuBar', AXMenuBarItem: 'MenuItem', AXMenu: 'Menu', AXMenuItem: 'MenuItem',
  AXScrollBar: 'ScrollBar', AXValueIndicator: 'Thumb', AXSplitter: 'Separator', AXWebArea: 'Document', AXHelpTag: 'Tooltip',
  AXProgressIndicator: 'Text', AXBusyIndicator: 'Text', AXLevelIndicator: 'Text', AXColorWell: 'Button', AXDateField: 'Edit', AXGrowArea: 'Separator',
};
const kindOfRole = (role) => KIND[String(role || '')] || (String(role || '').replace(/^AX/, '') || 'Element');
const SECURE = /^AXSecureTextField$/;
const TOGGLES = new Set(['CheckBox', 'RadioButton']);
const MAX_PATH = 40;

// toNodes(raw) -> { tree, refs: Map('e3' -> { path, role, name, desc }) }
function toNodes(raw) {
  const refs = new Map();
  let n = 0;
  const roles = new Map(); // role -> how many elements of it the window has (for the nameless rule)
  const count = (node) => { if (!node || typeof node !== 'object' || node.pw === true) return; roles.set(String(node.r || ''), (roles.get(String(node.r || '')) || 0) + 1); for (const c of Array.isArray(node.c) ? node.c : []) count(c); };
  count(raw);
  const conv = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (node.pw === true || SECURE.test(String(node.sr || ''))) return { pw: true }; // (nothing of a password field is copied, not even its name)
    const kind = kindOfRole(node.r);
    const name = String(node.n || node.d || '');
    const out = { t: kind, n: name };
    if (node.v !== undefined && node.v !== null && node.v !== '') {
      if (TOGGLES.has(kind)) { if (Number(node.v) === 1) out.k = true; } // a check box's value is 0 / 1: shown as "checked"
      else out.v = String(node.v);
    }
    if (node.en === false) out.en = false;
    if (node.sel === true) out.s = true;
    const path = Array.isArray(node.p) ? node.p.filter((x) => Number.isInteger(x) && x >= 0) : [];
    const named = Boolean(String(node.n || '') || String(node.d || ''));
    if (INTERACTIVE.has(kind) && path.length && path.length <= MAX_PATH && (named || roles.get(String(node.r || '')) === 1)) {
      const id = `e${++n}`;
      out.i = id;
      refs.set(id, { path, role: String(node.r || ''), name: String(node.n || ''), desc: String(node.d || '') });
    }
    const kids = Array.isArray(node.c) ? node.c.map(conv).filter(Boolean) : [];
    if (kids.length) out.c = kids;
    return out;
  };
  return { tree: conv(raw) || { t: 'Window', n: '' }, refs };
}

module.exports = { toNodes, kindOfRole, KIND };
