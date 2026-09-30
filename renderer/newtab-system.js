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
  // ---- the header's reserved room (see main > header in newtab.html) ----
  // Measured on a hidden copy of the header with the clock at its biggest size, the date and greeting shown, in each
  // clock style; the tallest is kept. Measured again only when something it depends on changes.
  let reserveKey = '';
  function reserveHeader(force = false) {
    if (!headerEl || headerEl.parentElement !== mainEl) return;
    const b = document.body.dataset;
    const greetingText = document.getElementById('greeting')?.textContent || '';
    const key = [mainEl.clientWidth, b.greetingFont, b.clockCard, b.clockShadow, greetingText].join('|');
    if (!force && key === reserveKey) return;
    reserveKey = key;
    const copy = headerEl.cloneNode(true);
    copy.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    copy.removeAttribute('id');
    copy.hidden = false;
    copy.querySelectorAll('[hidden]').forEach((n) => { n.hidden = false; });
    const clock = copy.querySelector('.clock');
    const span = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
    if (clock) clock.replaceChildren(span('clock-h', '88'), span('clock-sep', ':'), span('clock-m', '88'), span('clock-s', ':88')); // the widest time, seconds shown
    const date = copy.querySelector('.date');
    if (date && !date.textContent) date.textContent = 'Wednesday, September 30';
    Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', left: '0', top: '0', width: `${mainEl.clientWidth}px`, minHeight: '0', animation: 'none', pointerEvents: 'none' });
    copy.style.setProperty('--clock-size', `${WS.CLOCK_PX[WS.CLOCK_STEPS[WS.CLOCK_STEPS.length - 1]]}px`);
    copy.setAttribute('aria-hidden', 'true');
    mainEl.append(copy);
    const was = b.clockStyle;
    let tallest = 0;
    for (const style of (window.ClockStyles?.CLOCK_STYLES || [{ id: was }]).map((s) => s.id)) {
      b.clockStyle = style;
      tallest = Math.max(tallest, copy.getBoundingClientRect().height);
    }
    if (was === undefined) delete b.clockStyle; else b.clockStyle = was;
    copy.remove();
    mainEl.style.setProperty('--header-reserve', `${Math.ceil(tallest)}px`);
  }
  addEventListener('resize', () => reserveHeader());
  function paint() {
    mainEl.style.setProperty('--clock-size', `${WS.CLOCK_PX[size.clock]}px`);
    mainEl.style.setProperty('--search-w', `${size.search === WS.SEARCH_DEFAULT ? defaultSearchPx() : size.search}px`);
  }
  // A search width set in Settings goes as far as the cards beside the centre column allow and stops there, rather
  // than pushing them (the same rule as resizing it in Edit layout). Run once the page's cards are in place; the width
  // that fits is saved, so Settings shows what the page shows. (The clock always fits: its room is reserved.)
  function fitToCards() {
    const fits = () => window.widgetGrid?.centreFits?.() ?? true;
    if (size.hold || size.search === WS.SEARCH_DEFAULT || fits()) return;
    const wanted = size.search;
    let lo = WS.SEARCH_MIN, hi = size.search;
    while (hi - lo > WS.SEARCH_STEP) {
      const mid = Math.round((lo + hi) / 2 / WS.SEARCH_STEP) * WS.SEARCH_STEP;
      if (mid <= lo || mid >= hi) break;
      size.search = mid;
      paint();
      if (fits()) lo = mid; else hi = mid;
    }
    size.search = lo;
    paint();
    if (lo !== wanted) window.widgetAct?.('wlook', 'look', { k: 'search', v: String(lo) });
  }
  window.newtabSize = {
    apply(clock, search) {
      if (size.hold) return;
      size.clock = WS.cleanClockSize(clock) || WS.CLOCK_DEFAULT;
      size.search = WS.cleanSearchWidth(search) || WS.SEARCH_DEFAULT;
      paint();
    },
    // After the page's sections and cards are in place (newtab.js render): the header's room, then the search width.
    fit() { reserveHeader(); fitToCards(); },
    preview(clock, search) {
      if (clock) size.clock = WS.cleanClockSize(clock) || size.clock;
      if (search) size.search = WS.cleanSearchWidth(search) || size.search;
      paint();
    },
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
