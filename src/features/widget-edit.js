// New-tab "Edit layout" mode: the parts of it that are plain logic, so they can be tested without a
// page. renderer/newtab-edit.js (the toolbar, the Add widget tile and picker, snap guides, the undo
// toast) and renderer/newtab-widgets-grid.js (drag, resize, keys) draw and call these.
//
//   STRINGS / text()        the page's words (also in locales/en.json as newtab.edit.*)
//   createHistory()         the undo stack: layout changes, removals and stack changes, newest last
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
  'newtab.edit.reset.title': 'Put the sections back in the center and every widget at its default size',
  'newtab.edit.bar': 'Edit layout',
  'newtab.edit.hint': 'Drag a card to move it, or focus it and use the arrow keys. Shift and arrows resize it. Drag the clock’s corner or the search bar’s edges to size them; double-click one to reset it. Ctrl+Z undoes.',
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
  'newtab.edit.cancelled': 'Move canceled',
  'newtab.edit.removed': '{title} removed',
  'newtab.edit.hidden': '{title} hidden',
  'newtab.edit.stacked': '{title} stacked with {onto}. Scroll it or use the dots to switch.',
  'newtab.edit.unstacked': '{title} removed from its stack',
  'newtab.stack.next': 'Next widget',
  'newtab.stack.shown': '{title}, {n} of {count}',
  'newtab.stack.onto': 'Stack {title} onto {onto}',
  'newtab.stack.onto.title': 'Stack onto {onto}',
  'newtab.stack.unstack': 'Remove {title} from its stack',
  'newtab.stack.unstack.title': 'Remove from stack',
  'newtab.stack.role': 'widget stack',
  'newtab.stack.label': '{title}, {n} of {count}',
  'newtab.stack.prev': 'Previous widget',
  'newtab.stack.dot': 'Show {title}, {n} of {count}',
  'newtab.stack.why': 'Suggested: {why}',
  'newtab.stack.why.event': 'event starting soon',
  'newtab.stack.why.countdown': 'countdown ends within a day',
  'newtab.stack.why.morning': 'morning weather',
  'newtab.stack.edit': 'Edit the stack with {title}',
  'newtab.stack.edit.title': 'Edit stack',
  'newtab.stack.make': 'Stack {title} with another widget',
  'newtab.stack.make.title': 'Stack with another widget',
  'newtab.stack.panel': 'Edit stack',
  'newtab.stack.panel.hint': 'Drag the handle or use the arrows to reorder. The pencil on a card edits that widget; the stacked-squares button edits the stack.',
  'newtab.stack.done': 'Done',
  'newtab.stack.new': 'New stack',
  'newtab.stack.new.hint': 'Pick a widget to stack with. It resizes to match if needed.',
  'newtab.stack.new.none': 'No other widget to stack with yet.',
  'newtab.stack.new.one': 'Stack {title} with {onto}',
  'newtab.stack.grip': 'Move {title}, position {n} of {count}. Up and Down arrows reorder.',
  'newtab.stack.up': 'Move {title} earlier',
  'newtab.stack.down': 'Move {title} later',
  'newtab.stack.rotate': 'Rotate automatically',
  'newtab.stack.rotate.hint': 'Shows the next widget every 20 seconds while you are not using the stack',
  'newtab.stack.smart': 'Smart rotate',
  'newtab.stack.smart.hint': 'Shows the calendar before an event, a countdown on its last day and the weather in the morning',
  'newtab.stack.add': 'Add to this stack',
  'newtab.stack.add.one': 'Add {title} to this stack',
  'newtab.stack.add.none': 'No other widget to stack with yet.',
  'newtab.stack.smart.none': 'Add weather, calendar or a countdown to use Smart rotate',
  'newtab.stack.fits': 'Resizes to {size}',
  'newtab.stack.grows': 'Stack grows to {size}',
  'newtab.stack.full': 'A stack holds up to {max} widgets.',
  'newtab.stack.reordered': '{title} moved to position {n} of {count}',
  'newtab.stack.option': '{option}: {state}',
  'newtab.stack.on': 'on',
  'newtab.stack.off': 'off',
  'newtab.stack.menu': 'Edit stack…',
  'newtab.stack.menu.hint': 'Edit stack, right-click or long-press the dots',
  'newtab.stack.rail': 'Edit stack…',
  'newtab.edit.stackHint': 'Drag a widget onto another to stack them.',
  'newtab.edit.type.smartstack': 'Smart Stack',
  'newtab.edit.type.smartstack.hint': 'Widgets that take turns in one place. Starts with weather, a countdown and a note',
  'newtab.edit.smartstack.adding': 'Adding a Smart Stack with Weather, Countdown and Notes',
  'newtab.edit.smartstack.added': 'Smart Stack added. Scroll it to switch widgets, or edit it here.',
  'newtab.edit.restored': '{title} is back',
  'newtab.edit.undone': 'Undone: {what}',
  'newtab.edit.nothing': 'Nothing to undo',
  'newtab.edit.settingUp': 'Opening Settings to set up {title}',
  'newtab.edit.resetDone': 'Layout reset',
  'newtab.edit.what.layout': 'the change to {title}',
  'newtab.edit.clock': 'Clock size',
  'newtab.edit.clock.hint': 'Drag the corner, or focus it and use the arrow keys',
  'newtab.edit.clock.sized': 'Clock size: {size}',
  'newtab.edit.clock.s': 'small',
  'newtab.edit.clock.m': 'medium',
  'newtab.edit.clock.l': 'large',
  'newtab.edit.clock.xl': 'extra large',
  'newtab.edit.search': 'Search bar width',
  'newtab.edit.search.hint': 'Drag an edge, or focus it and use the arrow keys',
  'newtab.edit.search.sized': 'Search bar width: {width} pixels',
  'newtab.edit.noRoom': 'It stops here: a card is in the way.',
  'newtab.edit.drawnSmaller': 'Saved as {size}; smaller here so the cards keep their places',
  'newtab.edit.drawnNarrower': 'Saved as {size}; narrower here so the cards keep their places',
  'newtab.edit.automatic': 'Automatic',
  'newtab.edit.sizeHint': 'Arrow keys change the size. Page Up and Page Down take bigger steps; Home and End go to the smallest and largest.',
  'newtab.edit.what.removed': 'removing {title}',
  'newtab.edit.type.weather': 'Weather',
  'newtab.edit.type.weather.hint': 'Forecast for one or more places',
  'newtab.edit.type.calendar': 'Calendar',
  'newtab.edit.type.calendar.hint': 'Upcoming events from a calendar link',
  'newtab.edit.type.todoist': 'Todoist',
  'newtab.edit.type.todoist.hint': 'Your tasks',
  'newtab.edit.type.embed': 'Web page',
  'newtab.edit.type.embed.hint': 'Any page that allows being framed',
  'newtab.edit.type.worldclock': 'World clock',
  'newtab.edit.type.worldclock.hint': 'Times, dates and sunrise for places',
  'newtab.edit.type.spotify': 'Spotify',
  'newtab.edit.type.spotify.hint': 'What is playing, with controls',
  'newtab.edit.type.applemusic': 'Apple Music',
  'newtab.edit.type.applemusic.hint': 'What is playing in Apple Music, with controls',
  'newtab.edit.type.gmail': 'Gmail',
  'newtab.edit.type.gmail.hint': 'Unread count and latest messages',
  'newtab.edit.type.slack': 'Slack',
  'newtab.edit.type.slack.hint': 'Unread DMs, mentions and channel messages',
  'newtab.edit.type.github': 'GitHub',
  'newtab.edit.type.github.hint': 'Review requests, assigned items, notifications',
  'newtab.edit.type.feed': 'Headlines',
  'newtab.edit.type.feed.hint': 'News from an RSS or Atom feed',
  'newtab.edit.type.muse': 'Muse',
  'newtab.edit.type.muse.hint': 'Ask Meta’s Muse model, with a saved prompt',
  'newtab.edit.type.stocks': 'Stocks',
  'newtab.edit.type.stocks.hint': 'A watchlist and a paper portfolio',
  'newtab.edit.type.crypto': 'Crypto',
  'newtab.edit.type.crypto.hint': 'Coin prices and a paper portfolio',
  'newtab.edit.type.tradingview': 'TradingView',
  'newtab.edit.type.tradingview.hint': 'A live TradingView chart for a symbol',
  'newtab.edit.type.notes': 'Notes',
  'newtab.edit.type.notes.hint': 'A note that saves as you type',
  'newtab.edit.type.countdown': 'Countdown',
  'newtab.edit.type.countdown.hint': 'Days until a date',
  'newtab.edit.type.timer': 'Timer',
  'newtab.edit.type.timer.hint': 'A timer or Pomodoro focus and break',
  'newtab.edit.type.aistatus': 'AI status',
  'newtab.edit.type.aistatus.hint': 'Which AIs are ready, working or at a limit',
  'newtab.edit.type.custom': 'Custom',
  'newtab.edit.type.custom.hint': 'Your own card from a JSON recipe',
  'newtab.edit.type.other.hint': 'Set up in Settings',
};
// Label and one line for the kinds of widget this file knows; another kind gets its name and a generic line.
const TYPE_INFO = {
  weather: ['newtab.edit.type.weather', 'newtab.edit.type.weather.hint'],
  calendar: ['newtab.edit.type.calendar', 'newtab.edit.type.calendar.hint'],
  todoist: ['newtab.edit.type.todoist', 'newtab.edit.type.todoist.hint'],
  worldclock: ['newtab.edit.type.worldclock', 'newtab.edit.type.worldclock.hint'],
  spotify: ['newtab.edit.type.spotify', 'newtab.edit.type.spotify.hint'],
  applemusic: ['newtab.edit.type.applemusic', 'newtab.edit.type.applemusic.hint'],
  gmail: ['newtab.edit.type.gmail', 'newtab.edit.type.gmail.hint'],
  slack: ['newtab.edit.type.slack', 'newtab.edit.type.slack.hint'],
  github: ['newtab.edit.type.github', 'newtab.edit.type.github.hint'],
  feed: ['newtab.edit.type.feed', 'newtab.edit.type.feed.hint'],
  muse: ['newtab.edit.type.muse', 'newtab.edit.type.muse.hint'],
  stocks: ['newtab.edit.type.stocks', 'newtab.edit.type.stocks.hint'],
  crypto: ['newtab.edit.type.crypto', 'newtab.edit.type.crypto.hint'],
  tradingview: ['newtab.edit.type.tradingview', 'newtab.edit.type.tradingview.hint'],
  notes: ['newtab.edit.type.notes', 'newtab.edit.type.notes.hint'],
  countdown: ['newtab.edit.type.countdown', 'newtab.edit.type.countdown.hint'],
  timer: ['newtab.edit.type.timer', 'newtab.edit.type.timer.hint'],
  aistatus: ['newtab.edit.type.aistatus', 'newtab.edit.type.aistatus.hint'],
  custom: ['newtab.edit.type.custom', 'newtab.edit.type.custom.hint'],
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
    some(test) { return stack.some(test); },
    retain(keep) { for (let i = stack.length - 1; i >= 0; i--) if (!keep(stack[i])) stack.splice(i, 1); return stack.length; }, // drops what `keep` refuses
  };
}
// Config and removal entries outlive Edit layout (their Undo toast does); layout entries don't.
const survivesEditExit = (e) => Boolean(e) && (e.kind === 'config' || e.kind === 'remove');
// A config or removal the browser has let go of (ttl ms after it happened) can no longer be undone.
const timedOut = (e, now, ttl) => Boolean(e) && (e.kind === 'config' || e.kind === 'remove') && now - e.at > ttl;
const rectKey = (it) => `${it.x},${it.y},${it.w},${it.h},${it.snap || ''}`;
// Edit layout frees the page's sections into cards, which shrinks the centre column's obstacle, so a card the column
// was pushing down would jump up. holdBase(view, items, isSystem) notes, for each real card (not snapped), where it is
// drawn now (`to`) and the saved rect that put it there (`from`); holdItems(items, base) then keeps drawing it there
// for as long as its saved rect is unchanged (a change sends every card, and the saved rects take over).
function holdBase(view, items, isSystem) {
  const saved = new Map(items.map((i) => [i.id, i]));
  const base = new Map();
  for (const v of view) {
    const s = saved.get(v.id);
    if (s && !v.snap && !s.snap && !isSystem(v.id)) base.set(v.id, { from: rectKey(s), to: { x: v.x, y: v.y, w: v.w, h: v.h } });
  }
  return base;
}
function holdItems(items, base) {
  if (!base) return items;
  return items.map((it) => {
    const b = base.get(it.id);
    return b && !it.snap && rectKey(it) === b.from ? { ...it, ...b.to } : it;
  });
}
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
// table: the page's string table, if any; stack: offer a Smart Stack (a stack of starter widgets, first among the kinds).
// -> [{ kind: 'section' | 'stack' | 'widget', id?, type?, label, hint }]
function pickerEntries({ types = [], hidden = [], table, stack = false } = {}) {
  const out = [];
  if (stack) out.push({ kind: 'stack', label: text('newtab.edit.type.smartstack', null, table), hint: text('newtab.edit.type.smartstack.hint', null, table) }); // first: it is the way in
  for (const type of types) {
    const info = TYPE_INFO[type];
    out.push({ kind: 'widget', type, label: info ? text(info[0], null, table) : cap(type), hint: text(info ? info[1] : 'newtab.edit.type.other.hint', null, table) });
  }
  // After the widgets: a few "Show again" rows must not push real widgets below the fold.
  for (const h of hidden) out.push({ kind: 'section', id: h.id, label: h.label, hint: text('newtab.edit.picker.section', null, table) });
  return out;
}

// ---- where floating things go ----
// Rects are { left, top, right, bottom } in px (the viewport's).
const overlapArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const boxAt = (left, top, size) => ({ left, top, right: left + size.w, bottom: top + size.h });
const clampTo = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
// The Edit stack panel: beside the card it edits (right, left, below, above, in that order of preference), never
// over the card itself, over the fewest other cards, and clear of what must stay reachable (the toolbar, the picker, a
// toast). o = { size: { w, h }, view: { w, h }, own: rect (the stack's card), others: [rects], avoid: [rects], gap, margin }.
// -> { left, top, side } where side is 'right' | 'left' | 'below' | 'above'.
function placePanel({ size, view, own, others = [], avoid = [], gap = 12, margin = 8 }) {
  const h = Math.min(size.h, view.h - 2 * margin);
  const sz = { w: size.w, h };
  const midY = clampTo(own.top, margin, view.h - h - margin);
  const midX = clampTo(own.left, margin, view.w - sz.w - margin);
  // Beside the card, level with its top; or, when the toolbar is in the way down there, lifted clear above it.
  const lift = avoid.length ? clampTo(Math.min(...avoid.map((r) => r.top)) - gap - h, margin, midY) : midY;
  const spots = [
    ['right', own.right + gap, midY],
    ['left', own.left - gap - sz.w, midY],
    ['right', own.right + gap, lift],
    ['left', own.left - gap - sz.w, lift],
    ['below', midX, own.bottom + gap],
    ['above', midX, own.top - gap - sz.h],
  ];
  let best = null;
  for (const [side, x, y] of spots) {
    const left = clampTo(x, margin, view.w - sz.w - margin);
    const top = clampTo(y, margin, view.h - sz.h - margin);
    const box = boxAt(left, top, sz);
    const score = overlapArea(box, own) * 1000 + avoid.reduce((a, r) => a + overlapArea(box, r) * 2, 0) + others.reduce((a, r) => a + overlapArea(box, r), 0);
    if (!best || score < best.score) best = { left, top, side, score };
  }
  // The usual spots overlap something: hit-test the free space. Candidate corners come from the edges of the other cards
  // (just beyond each one), the window's edges and the stack's own; the one that covers the least wins, nearest to the stack on a tie.
  if (best.score > 0) {
    const maxL = view.w - sz.w - margin;
    const maxT = view.h - sz.h - margin;
    const xs = [margin, maxL, midX, own.right + gap, own.left - gap - sz.w, ...others.flatMap((r) => [r.right + gap, r.left - gap - sz.w])];
    const ys = [margin, maxT, midY, lift, own.bottom + gap, own.top - gap - sz.h, ...others.flatMap((r) => [r.bottom + gap, r.top - gap - sz.h])];
    const cx = (own.left + own.right) / 2;
    const cy = (own.top + own.bottom) / 2;
    let found = null;
    for (const x of xs) {
      for (const y of ys) {
        const left = clampTo(x, margin, maxL);
        const top = clampTo(y, margin, maxT);
        const box = boxAt(left, top, sz);
        const score = overlapArea(box, own) * 1000 + avoid.reduce((a, r) => a + overlapArea(box, r) * 2, 0) + others.reduce((a, r) => a + overlapArea(box, r), 0);
        const dist = Math.hypot(left + sz.w / 2 - cx, top + sz.h / 2 - cy);
        if (!found || score < found.score || (score === found.score && dist < found.dist)) found = { left, top, score, dist, side: left >= own.right ? 'right' : left + sz.w <= own.left ? 'left' : top >= own.bottom ? 'below' : top + sz.h <= own.top ? 'above' : 'right' };
      }
    }
    if (found && found.score < best.score) best = found;
  }
  // Nothing is free: centered over the page (the caller dims what is behind it).
  if (best.score > 0) {
    return { left: Math.round((view.w - sz.w) / 2), top: Math.round(clampTo((view.h - sz.h) / 2, margin, view.h - sz.h - margin)), side: 'center' };
  }
  return { left: best.left, top: best.top, side: best.side };
}
// The Undo toast: centered above the toolbar by default; it never lands on the toolbar, the Edit stack panel or the
// picker (obstacles): it moves aside (left or right) or above them. o = { size, view, obstacles: [rects], base (the
// toast's lowest edge: just above the toolbar), margin, gap }. -> { left, top }.
function placeToast({ size, view, obstacles = [], base, margin = 16, gap = 10 }) {
  const floor = Number.isFinite(base) ? base : view.h - margin;
  const rows = [floor, ...obstacles.map((r) => r.top - gap)];
  const cols = [(view.w - size.w) / 2, margin, view.w - size.w - margin];
  let best = null;
  for (const bottom of rows) {
    for (const x of cols) {
      const left = clampTo(x, margin, view.w - size.w - margin);
      const top = bottom - size.h;
      const box = boxAt(left, top, size);
      const off = top < margin ? (margin - top) * size.w * 4 : 0; // off the top of the window
      const score = obstacles.reduce((a, r) => a + overlapArea(box, r) * 1000, 0) + off;
      if (!best || score < best.score) best = { left, top, score };
      if (score === 0) return { left, top };
    }
  }
  return { left: best.left, top: best.top };
}

// Typing somewhere (a field, a select or a contenteditable): Ctrl/Cmd+Z there belongs to the text, not to the page's Undo.
function isTypingTarget(node) {
  return Boolean(node) && (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName || '') || node.isContentEditable === true);
}
// The platform's modifier for the Undo hint: "Cmd" on a Mac, else "Ctrl".
function undoHint(platform) {
  return (/mac|iphone|ipad/i.test(String(platform || '')) ? 'Cmd' : 'Ctrl') + '+Z';
}

const api = { isTypingTarget, undoHint, STRINGS, TYPE_INFO, text, createHistory, survivesEditExit, timedOut, undoPlan, guides, pickerEntries, rectKey, holdBase, holdItems, placePanel, placeToast, overlapArea };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.WidgetEdit = api;
})();
