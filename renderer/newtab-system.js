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
  const isFree = (id) => shown(id) && !stackedNow() && (persisted.has(id) || origin.has(id));
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
    window.widgetGrid?.attach(card);
    return card;
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
    const m = WL.metrics(document.documentElement.clientWidth);
    const boxes = {};
    const rectOfNode = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, top: r.top + window.scrollY, width: r.width, height: r.height }; };
    for (const id of WS.IDS) {
      if (isFree(id) || !shown(id)) continue;
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
  });

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
