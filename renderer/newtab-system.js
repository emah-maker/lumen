// [widgets] The page's own sections as cards (features/widget-system.js has the rules). Until one is
// moved or resized it is exactly what it always was: header, search form and sections in the centre
// column. Free ones (stored with a rect in the browser's widget list) and, while Edit layout is on, all
// of them are cards on the widget grid: the same element is moved into a card in #widgets, so text typed
// in the search box, focus and the tiles all stay. Leaving Edit layout puts back whatever wasn't changed.
//
//   fill(parts, opts, list)  newtab.js, each render: put every section where it belongs (docked or in its card)
//   entries() / cards()      what newtab-widgets.js hands the grid besides the widgets
//   freeAll() / settle()     Edit layout on / off
//   touch() / isPristine()   which free cards the browser has been told about (only those are sent)
(() => {
  const WS = window.WidgetSystem;
  const WL = window.WidgetLayout;
  const mainEl = document.querySelector('main');
  const headerEl = mainEl.querySelector('header');
  const formEl = mainEl.querySelector('form');
  const sectionsEl = document.getElementById('sections');
  const boxEl = () => document.getElementById('widgets');
  // id -> the part of newtab.js that fills it: 'sys-favorites' -> favorites, ...
  const KEY = { wsyshead: 'header', wsyssearch: 'search', wsysfavs: 'favorites', wsysfreq: 'frequent', wsyspriv: 'privacy' };
  const ORDER = ['wsysfavs', 'wsysfreq', 'wsyspriv']; // the docked sections, top to bottom
  const wrappers = new Map(); // id -> card element (only while free)
  const persisted = new Map(); // id -> layout, as the browser stores it
  const origin = new Map(); // id -> rect in cells, where it sat when Edit layout began (unsaved)
  const touched = new Set(); // ids changed since, whose rect has been (or is being) sent
  let parts = {};
  let opts = { header: true };
  let raw = [];
  let lastStacked = null;

  const stackedNow = () => WL.metrics(document.documentElement.clientWidth).cols === 1;
  const shown = (id) => (id === 'wsyshead' ? opts.header !== false : id === 'wsyssearch' ? true : Boolean(parts[KEY[id]]));
  // The clock and the search box stay where they always were (centred, the clock above the search box); widgets work around them.
  const PINNED = new Set(['wsyshead', 'wsyssearch']);
  const isFree = (id) => shown(id) && !PINNED.has(id) && !stackedNow() && (persisted.has(id) || origin.has(id));
  const layoutOf = (id) => persisted.get(id) || origin.get(id);

  function makeCard(id) {
    const def = WS.SYSTEM[id];
    const card = document.createElement('article');
    const bare = id === 'wsyshead' || id === 'wsyssearch'; // no visible title: the card is the thing itself
    card.className = `w-card sys sys-${KEY[id]}${bare ? ' sys-bare' : ''}`;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', def.label);
    card.dataset.id = id;
    card.dataset.sys = def.type;
    if (id === 'wsyssearch') card.dataset.keep = '1'; // the search box can't be removed
    const head = document.createElement('div');
    head.className = 'w-head';
    const h2 = document.createElement('h2');
    h2.textContent = def.label;
    head.append(h2);
    const body = document.createElement('div');
    body.className = 'w-body';
    card.append(head, body);
    watchFit(body);
    window.widgetGrid?.attach(card);
    return card;
  }
  // A section card scrolls only when its content really is taller than the card: a few px of rounding or padding
  // slack (the body is overflow-y: auto) must not show a scrollbar or let the wheel move a section that fits.
  const SLACK = 8;
  function watchFit(body) {
    const check = () => {
      if (!body.isConnected) return;
      body.style.overflowY = 'hidden';
      body.style.overflowY = body.scrollHeight - body.clientHeight > SLACK ? '' : 'hidden';
    };
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(check);
      ro.observe(body);
      new MutationObserver(() => { requestAnimationFrame(check); ro.disconnect(); ro.observe(body); for (const c of body.children) ro.observe(c); }).observe(body, { childList: true });
    }
    requestAnimationFrame(check);
  }
  const bodyOf = (card) => card.querySelector('.w-body');
  // Move a node only when it isn't already there: a moved input loses focus.
  function put(node, parent, before = null) {
    if (node.parentNode === parent && node.nextSibling === before) return;
    node.style.animation = 'none'; // the entrance animation is for the first paint only
    parent.insertBefore(node, before);
  }

  function place() {
    // Shared elements first: take them out of any card that is going away.
    for (const id of ['wsyshead', 'wsyssearch']) {
      const node = id === 'wsyshead' ? headerEl : formEl;
      if (isFree(id)) {
        if (!wrappers.has(id)) wrappers.set(id, makeCard(id));
        const body = bodyOf(wrappers.get(id));
        put(node, body);
      }
    }
    // Docked: header, form, then the sections, in the centre column (the form first: the header goes before it).
    headerEl.hidden = opts.header === false;
    if (!isFree('wsyssearch')) put(formEl, mainEl, sectionsEl);
    if (!isFree('wsyshead')) put(headerEl, mainEl, isFree('wsyssearch') ? sectionsEl : formEl);
    const docked = [];
    for (const id of ORDER) {
      const part = parts[KEY[id]];
      if (!part) continue;
      if (isFree(id)) {
        if (!wrappers.has(id)) wrappers.set(id, makeCard(id));
        const card = wrappers.get(id);
        card.querySelector('h2').textContent = part.title;
        card.setAttribute('aria-label', part.title);
        bodyOf(card).replaceChildren(part.content);
      } else {
        if (part.content.parentNode !== part.section) part.section.append(part.content);
        docked.push(part.section);
      }
    }
    sectionsEl.replaceChildren(...docked);
    // Cards that are no longer free (or shown) go.
    for (const [id, card] of wrappers) {
      if (isFree(id)) { if (!card.isConnected) boxEl().append(card); continue; }
      card.remove();
      wrappers.delete(id);
    }
  }

  // Each render: `parts` = { favorites, frequent, privacy: { title, section, content } | null }, `o` = { header },
  // `list` = the browser's widget list, whose system entries say which cards are free.
  function fill(nextParts, o, list) {
    parts = nextParts;
    opts = o || opts;
    raw = list;
    persisted.clear();
    for (const w of Array.isArray(list) ? list : []) {
      if (!w || !w.system || !WS.isSystemId(w.id)) continue;
      const c = WS.clean({ id: w.id, ...w.layout });
      if (c) { persisted.set(c.id, WL.rectOf(c)); if (c.snap) persisted.get(c.id).snap = c.snap; }
    }
    for (const id of persisted.keys()) touched.delete(id);
    lastStacked = stackedNow();
    place();
  }
  const entries = () => WS.IDS.filter(isFree).map((id) => ({ id, type: WS.typeOf(id), title: WS.labelOf(id), layout: layoutOf(id) }));
  const cards = () => new Map([...wrappers].filter(([id]) => isFree(id)));

  // Edit layout on: every shown section becomes a card where it stands.
  function freeAll() {
    if (stackedNow()) return;
    const m = window.widgetGrid?.metrics() || WL.metrics(document.documentElement.clientWidth); // rows lined up with the centre column
    const boxes = {};
    const rectOfNode = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, top: r.top + window.scrollY, width: r.width, height: r.height }; };
    for (const id of WS.IDS) {
      if (isFree(id) || PINNED.has(id) || !shown(id)) continue;
      const node = id === 'wsyshead' ? headerEl : id === 'wsyssearch' ? formEl : parts[KEY[id]].section;
      boxes[id] = rectOfNode(node);
    }
    for (const [id, box] of Object.entries(boxes)) {
      const rect = WS.cellsFromBox(id, box, m);
      if (rect) origin.set(id, rect);
    }
    refill();
  }
  // Edit layout off: the sections nobody changed go back to the centre column.
  function settle() {
    let changed = false;
    for (const id of [...origin.keys()]) {
      if (persisted.has(id) || touched.has(id)) continue;
      origin.delete(id);
      changed = true;
    }
    if (changed) refill();
  }
  function refill() {
    fill(parts, opts, raw);
    window.renderWidgets?.(raw);
  }
  addEventListener('resize', () => {
    if (stackedNow() !== lastStacked) requestAnimationFrame(refill);
    if (size.search === WS.SEARCH_DEFAULT) paint(); // the column's span follows the window
  });

  // The centre column's own size: --clock-size and --search-w on <main> (Settings newTabClockSize / newTabSearchWidth).
  // apply() is the saved look (ignored while Edit layout is dragging, `hold`); preview() the live value of a drag.
  // The grid watches <main>'s size, so the cards beside it re-resolve by themselves.
  const size = { clock: WS.CLOCK_DEFAULT, search: WS.SEARCH_DEFAULT, hold: false };
  // The default search width is the width of the centre column's columns, so the column has no dead padding
  // beside it (640 px sits between column spans; the grid rounds up to the next even span). A width somebody
  // chose (anything but the default) is kept as it is; one column when stacked keeps the CSS default.
  function defaultSearchPx() {
    const m = WL.metrics(document.documentElement.clientWidth);
    if (m.cols === 1) return WS.SEARCH_DEFAULT;
    // Six columns when they are at least the narrowest search bar wide, else eight: side columns stay for cards.
    const span = WL.spanPx(m, 6) >= WS.SEARCH_MIN - 2 ? 6 : 8;
    return Math.round(WL.spanPx(m, span) * 100) / 100;
  }
  // ---- the search box's height on the page (see main in newtab.html) ----
  // The header as it is at its plainest (Medium clock, Classic style, no card, date and greeting shown) sets where the
  // search box sits: 88 px of space above that header. A bigger or fancier header takes its extra height from that
  // space (down to 16 px), so the search box never moves; a header with the clock or greeting off leaves more space.
  let refKey = '';
  let refHeight = 0;
  function plainHeaderHeight() {
    const greetingText = document.getElementById('greeting')?.textContent || '';
    const refWidth = Math.round(defaultSearchPx());
    const key = [refWidth, greetingText].join('|');
    if (key === refKey) return refHeight;
    refKey = key;
    const copy = headerEl.cloneNode(true);
    copy.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    copy.hidden = false;
    copy.querySelectorAll('[hidden]').forEach((n) => { n.hidden = false; });
    const span = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
    copy.querySelector('.clock')?.replaceChildren(span('clock-h', '8'), span('clock-sep', ':'), span('clock-m', '88'));
    const date = copy.querySelector('.date');
    if (date && !date.textContent) date.textContent = 'Wednesday, September 30';
    Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', left: '0', top: '0', width: `${refWidth}px`, animation: 'none', pointerEvents: 'none' });
    copy.style.setProperty('--clock-size', `${WS.CLOCK_PX[WS.CLOCK_DEFAULT]}px`);
    copy.setAttribute('aria-hidden', 'true');
    const b = document.body.dataset;
    const was = { style: b.clockStyle, card: b.clockCard, font: b.greetingFont };
    Object.assign(b, { clockStyle: 'classic', clockCard: 'none', greetingFont: 'classic' });
    mainEl.append(copy);
    refHeight = copy.offsetHeight;
    copy.remove();
    for (const [k, v] of [['clockStyle', was.style], ['clockCard', was.card], ['greetingFont', was.font]]) { if (v === undefined) delete b[k]; else b[k] = v; }
    return refHeight;
  }
  const TOP = 88;
  const MIN_TOP = 16;
  function anchorSearch() {
    if (!headerEl || headerEl.parentElement !== mainEl) { mainEl.style.removeProperty('--main-pad'); return; }
    // A hidden header leaves its room: the search box stays where it was, so nothing below it moves either.
    const pad = Math.max(MIN_TOP, TOP + plainHeaderHeight() - (headerEl.hidden ? 0 : headerEl.offsetHeight));
    mainEl.style.setProperty('--main-pad', `${Math.round(pad)}px`);
  }
  // A new window size: the search box's place, and sizes that fit this window (a size drawn smaller comes back when
  // there is room again).
  // (The grid re-fits the sizes on each resize frame, before it lays the cards out: see newtab-widgets-grid relayout.)
  addEventListener('resize', () => anchorSearch());
  // size.view: what is drawn right now, which may be smaller than the saved size when cards leave no room (fitToCards).
  function paint() {
    const clock = size.viewClock || size.clock;
    const search = size.viewSearch || size.search;
    mainEl.style.setProperty('--clock-size', `${WS.CLOCK_PX[clock]}px`);
    mainEl.style.setProperty('--search-w', `${search === WS.SEARCH_DEFAULT ? defaultSearchPx() : search}px`);
    anchorSearch();
  }
  // A size set in Settings (or saved from a wider window) is drawn as big as the cards around the centre column allow
  // in this window, and no bigger, rather than pushing them: the clock steps down, the search bar narrows. Only what
  // is drawn changes: the saved size stays, and comes back where there is room for it.
  // Cards whose saved places overlap the centre column even at its smallest (a narrow window): pushed whatever the
  // clock and search bar do, so they never block a size.
  function floorBlockers() {
    const grid = window.widgetGrid;
    if (!grid?.centreFits) return new Set();
    const was = { c: size.viewClock, s: size.viewSearch };
    size.viewClock = WS.CLOCK_STEPS[0];
    size.viewSearch = WS.SEARCH_MIN;
    paint();
    grid.centreFits();
    const ids = new Set(grid.blockers?.() || []);
    size.viewClock = was.c;
    size.viewSearch = was.s;
    paint();
    return ids;
  }
  const savedPx = () => (size.search === WS.SEARCH_DEFAULT ? defaultSearchPx() : size.search);
  function fitToCards() {
    if (size.hold) return; // a resize is being dragged: what it draws stays as it is
    size.viewClock = null;
    size.viewSearch = null;
    paint();
    const grid = window.widgetGrid;
    if (!grid?.centreFits || grid.centreFits()) return;
    const ignore = floorBlockers();
    const from = savedPx();
    const m = WL.metrics(document.documentElement.clientWidth);
    const lines = m.cols === 1 ? [] : [4, 6, 8, 10].map((s) => Math.floor(WL.spanPx(m, s)));
    const tryFits = (c, s) => {
      size.viewClock = c === size.clock ? null : c;
      size.viewSearch = s === from ? null : s;
      paint();
      return grid.centreFits(ignore);
    };
    const plan = WS.fitSizes({ clock: size.clock, search: from, widths: WS.fitWidths(from, lines) }, tryFits);
    size.viewClock = plan.clock;
    size.viewSearch = plan.search;
    paint();
  }
  window.newtabSize = {
    apply(clock, search) {
      if (size.hold) return;
      const c = WS.cleanClockSize(clock) || WS.CLOCK_DEFAULT;
      const s = WS.cleanSearchWidth(search) || WS.SEARCH_DEFAULT;
      if (c === size.clock && s === size.search) return; // the echo of a size just taken: already drawn
      size.clock = c;
      size.search = s;
      fitToCards();
    },
    // After the page's sections and cards are in place (newtab.js render): the search box's height, then the sizes.
    fit() { anchorSearch(); fitToCards(); },
    anchor: () => anchorSearch(),
    drawnSearch: () => size.viewSearch || size.search,
    drawnClock: () => size.viewClock || size.clock,
    fitNow: () => fitToCards(), // the grid calls this once it has the cards, before drawing them
    // A drag or key press shows a size: only what is drawn changes, never the saved size.
    preview(clock, search) {
      if (clock) size.viewClock = WS.cleanClockSize(clock) || size.viewClock;
      if (search) size.viewSearch = WS.cleanSearchWidth(search) || size.viewSearch;
      paint();
    },
    restore: () => fitToCards(), // the saved sizes again, fitted (a cancelled drag, a size with no room)
    take(key, value) { // a size chosen in Edit layout: saved here at once (the browser's echo then changes nothing)
      if (key === 'clock') size.clock = WS.cleanClockSize(value) || size.clock;
      else size.search = WS.cleanSearchWidth(value) || size.search;
      fitToCards();
    },
    floor: () => floorBlockers(),
    hold(on) { size.hold = Boolean(on); },
    held: () => size.hold,
    get: () => ({ clock: size.clock, search: size.search }),
  };

  const isPristine = (id) => WS.isSystemId(id) && !persisted.has(id) && !touched.has(id);
  window.newtabSystem = {
    fill, entries, cards, freeAll, settle, isPristine, isShown: shown,
    touch: (ids) => { for (const id of ids) if (WS.isSystemId(id)) touched.add(id); },
    untouch: (ids) => { for (const id of ids) touched.delete(id); },
    isPersisted: (id) => persisted.has(id),
    hasTouched: (id) => touched.has(id),
    dockedCount: () => WS.IDS.filter((id) => shown(id) && !isFree(id)).length,
    // The kinds of card an "Add widget" picker can bring back: sections that are switched off.
    hidden: () => WS.IDS.filter((id) => WS.prefOf(id) && !shown(id)),
  };
})();
