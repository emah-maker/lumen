// New-tab "Edit layout" mode: the parts of it that are plain logic, so they can be tested without a
// page. renderer/newtab-edit.js (the toolbar, the Add widget tile and picker, snap guides, the undo
// toast) and renderer/newtab-widgets-grid.js (drag, resize, keys) draw and call these.
//
//   STRINGS / text()        the page's words (also in locales/en.json as newtab.edit.*)
//   createHistory()         the undo stack: layout changes and removals, newest last
//   undoPlan(prev, cur)     what to send to get from the current layout back to a previous one
//   guides(rect, others)    snap guides: the grid lines the moving card lines up with
//   pickerEntries(o)        what the Add widget picker offers
//   TYPE_INFO               a label and a line for each kind of widget in the picker
(function () {
'use strict';

const STRINGS = {
  'newtab.edit.toggle': 'Edit layout',
  'newtab.edit.toggle.title': 'Move, resize, add and remove the cards on this page',
  'newtab.edit.done': 'Done',
  'newtab.edit.add': 'Add widget',
  'newtab.edit.add.title': 'Add a widget or show a section again',
  'newtab.edit.undo': 'Undo',
  'newtab.edit.undo.title': 'Undo the last change (Ctrl+Z)',
  'newtab.edit.reset': 'Reset layout',
  'newtab.edit.reset.title': 'Put the sections back in the centre and every widget at its default size',
  'newtab.edit.bar': 'Edit layout',
  'newtab.edit.hint': 'Drag a card to move it, or focus it and use the arrow keys. Shift and arrows resize it. Ctrl+Z undoes.',
  'newtab.edit.tile': 'Add widget',
  'newtab.edit.tile.empty': 'Nothing here yet. Add the weather, your calendar, your tasks or any web page.',
  'newtab.edit.picker': 'Add to this page',
  'newtab.edit.picker.section': 'Show again',
  'newtab.edit.picker.none': 'Everything is already on the page.',
  'newtab.edit.picker.close': 'Close',
  'newtab.edit.firstRun': 'Make this page yours: move Favorites, or add the weather and your tasks.',
  'newtab.edit.dismiss': 'Dismiss',
  'newtab.edit.entered': 'Editing layout. Drag a card to move it, or use the arrow keys. Shift and arrows resize. Control Alt and arrows snap to a side. Control Z undoes. Escape or Done to finish.',
  'newtab.edit.left': 'Done editing layout.',
  'newtab.edit.cancelled': 'Move cancelled',
  'newtab.edit.removed': '{title} removed',
  'newtab.edit.hidden': '{title} hidden',
  'newtab.edit.restored': '{title} is back',
  'newtab.edit.undone': 'Undone: {what}',
  'newtab.edit.nothing': 'Nothing to undo',
  'newtab.edit.settingUp': 'Opening Settings to set up {title}',
  'newtab.edit.resetDone': 'Layout reset',
  'newtab.edit.what.layout': 'the change to {title}',
  'newtab.edit.what.removed': 'removing {title}',
  'newtab.edit.type.weather': 'Weather',
  'newtab.edit.type.weather.hint': 'Forecast for one or more places',
  'newtab.edit.type.calendar': 'Calendar',
  'newtab.edit.type.calendar.hint': 'Upcoming events from an ICS link',
  'newtab.edit.type.todoist': 'Todoist',
  'newtab.edit.type.todoist.hint': 'Your tasks',
  'newtab.edit.type.embed': 'Web page',
  'newtab.edit.type.embed.hint': 'Any page that allows being framed',
  'newtab.edit.type.other.hint': 'Set up in Settings',
};
// Label and one line for the kinds of widget this file knows; another kind gets its name and a generic line.
const TYPE_INFO = {
  weather: ['newtab.edit.type.weather', 'newtab.edit.type.weather.hint'],
  calendar: ['newtab.edit.type.calendar', 'newtab.edit.type.calendar.hint'],
  todoist: ['newtab.edit.type.todoist', 'newtab.edit.type.todoist.hint'],
  embed: ['newtab.edit.type.embed', 'newtab.edit.type.embed.hint'],
};

// A string, translated when the page was given a table (window.lumenI18n.strings), else English.
function text(key, vars, table) {
  const own = table && typeof table[key] === 'string' ? table[key] : null;
  const raw = own ?? STRINGS[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole)) : raw;
}

// ---- undo ----
// Entries: { kind: 'layout', before: [items], after: [items], id, title } or { kind: 'remove', id, title, system }.
function createHistory(limit = 20) {
  const stack = [];
  return {
    push(entry) { stack.push(entry); while (stack.length > limit) stack.shift(); return stack.length; },
    pop() { return stack.pop() || null; },
    peek() { return stack[stack.length - 1] || null; },
    clear() { stack.length = 0; },
    get size() { return stack.length; },
  };
}
const rectKey = (it) => `${it.x},${it.y},${it.w},${it.h},${it.snap || ''}`;
// To go from the layout `cur` back to `prev` (both: [{ id, x, y, w, h, snap? }], system cards that are
// free included): `items` are the cards to send (only those that differ, and only ones that still
// exist), `dock` the system cards that were untouched then and have been changed since (their stored
// rect goes, and they are back in the centre column). o = { isSystem(id), pristine: Set of ids that
// were untouched in `prev`, touched: Set of ids whose rect is stored or being stored now }.
// Null when there is nothing to do.
function undoPlan(prev, cur, { isSystem = () => false, pristine = new Set(), touched = new Set() } = {}) {
  if (!Array.isArray(prev) || !Array.isArray(cur)) return null;
  const now = new Map(cur.map((it) => [it.id, it]));
  const items = prev.filter((it) => {
    if (isSystem(it.id) && pristine.has(it.id)) return false;
    return now.has(it.id) ? rectKey(now.get(it.id)) !== rectKey(it) : isSystem(it.id);
  });
  const dock = [...pristine].filter((id) => isSystem(id) && touched.has(id) && now.has(id));
  const changed = prev.some((it) => now.has(it.id) && rectKey(now.get(it.id)) !== rectKey(it));
  if (!items.length && !dock.length) return changed ? { items: [], dock: [], local: true } : null;
  // The action needs a layout to carry the dock list; an unchanged card will do.
  if (!items.length) items.push(prev[0] || cur[0]); // a docked card is dropped by the browser even when it is in the list
  return { items, dock };
}

// ---- snap guides ----
// The grid lines (in cells) that a card's edges share with other cards' edges or the centre column's:
// [{ axis: 'x' | 'y', at, from, to }], `from`..`to` being the stretch to draw (the two cards' extent).
// A vertical line at x = 3 is the boundary between column 2 and column 3.
function guides(rect, others, limit = 8) {
  const out = [];
  const seen = new Set();
  const add = (g) => { const k = `${g.axis}${g.at}:${g.from}:${g.to}`; if (!seen.has(k)) { seen.add(k); out.push(g); } };
  for (const o of others) {
    if (!o) continue;
    for (const a of [rect.x, rect.x + rect.w]) {
      for (const b of [o.x, o.x + o.w]) if (a === b) add({ axis: 'x', at: a, from: Math.min(rect.y, o.y), to: Math.max(rect.y + rect.h, o.y + o.h) });
    }
    for (const a of [rect.y, rect.y + rect.h]) {
      for (const b of [o.y, o.y + o.h]) if (a === b) add({ axis: 'y', at: a, from: Math.min(rect.x, o.x), to: Math.max(rect.x + rect.w, o.x + o.w) });
    }
  }
  return out.slice(0, limit);
}

// ---- the Add widget picker ----
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
// types: the kinds of widget the page can draw; hidden: [{ id, label }] sections that are switched off;
// table: the page's string table, if any. -> [{ kind: 'section' | 'widget', id?, type?, label, hint }]
function pickerEntries({ types = [], hidden = [], table } = {}) {
  const out = hidden.map((h) => ({ kind: 'section', id: h.id, label: h.label, hint: text('newtab.edit.picker.section', null, table) }));
  for (const type of types) {
    const info = TYPE_INFO[type];
    out.push({ kind: 'widget', type, label: info ? text(info[0], null, table) : cap(type), hint: text(info ? info[1] : 'newtab.edit.type.other.hint', null, table) });
  }
  return out;
}

const api = { STRINGS, TYPE_INFO, text, createHistory, undoPlan, guides, pickerEntries, rectKey };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.WidgetEdit = api;
})();
