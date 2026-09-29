// [widgets] Where the cards sit, and how they move: a 12-column grid over the whole page (the centre
// column with the search box is an obstacle they never overlap; features/widget-layout.js does the
// arithmetic, this file draws it and handles the pointer and keyboard).
//
// Cards are positioned with transforms only and never reordered in the DOM (a moved frame would
// reload). Dragging follows the pointer with a transform; the other cards slide out of the way and a
// ghost shows where the card will land. Edit mode ("Edit widgets", or a long press on a card) lets a
// card be dragged from anywhere, resized from every corner and edge, snapped to a side, resized to a
// preset, configured (the gear) or removed. Drops are sent as one layout (do=layout).
(() => {
  const WL = window.WidgetLayout;
  const body = document.body;
  const mainEl = document.querySelector('main');
  const boxEl = () => document.getElementById('widgets');
  let cardsById = new Map();
  let items = []; // [{ id, type, title, x, y, w, h, snap? }] as the browser has them (or as just sent)
  let view = []; // the same, as drawn now (obstacle, packing, window size applied)
  let m = null; // WL.metrics()
  let o = null; // { cols, obstacle, packed, rows }
  let drag = null;
  let editing = false;
  let optimistic = null; // { map, at }: what we just sent, until the browser's list agrees
  let deferred = null;
  let mainMargin = 0;
  let firstLayout = true;
  let suppress = false;
  let editBtn = null;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const say = (t) => window.widgetAnnounce?.(t);
  const SNAP_WORDS = { left: 'the left side', right: 'the right side', top: 'the top', tl: 'the top left', tr: 'the top right', bl: 'the bottom left', br: 'the bottom right' };
  const titleOf = (card) => card.getAttribute('aria-label') || 'Widget';
  const stacked = () => !m || m.cols === 1;

  // ---- drawing ----
  function measure() {
    m = WL.metrics(document.documentElement.clientWidth);
    const bottom = mainEl.offsetTop + mainEl.offsetHeight - mainMargin - 32;
    const obstacle = WL.obstacleFor({ left: mainEl.offsetLeft, right: mainEl.offsetLeft + mainEl.offsetWidth, bottom }, m);
    o = { cols: m.cols, obstacle, packed: body.dataset.wpack !== '0', rows: WL.pageRows(window.innerHeight, m) };
    body.classList.toggle('w-stacked', m.cols === 1);
    if (m.cols === 1 && editing) setEditing(false);
  }
  function setBox(card, px) {
    const key = `${px.left},${px.top},${px.width},${px.height}`;
    if (card._pos === key) return;
    card._pos = key;
    card.style.transform = `translate3d(${px.left}px, ${px.top}px, 0)`;
    card.style.width = `${px.width}px`;
    card.style.height = `${px.height}px`;
  }
  function setCell(card, it) {
    const key = WL.encode([it]);
    if (card._cell === key) return;
    card._cell = key;
    card.dataset.cell = `${it.x},${it.y},${it.w},${it.h}`;
    const mir = WL.mirror(it.type, it);
    card.dataset.span = String(mir.span);
    if (it.snap) card.dataset.snap = it.snap; else delete card.dataset.snap;
    const frame = card.querySelector('.w-frame');
    if (frame && mir.height) frame.dataset.h = mir.height;
    const title = titleOf(card);
    card.querySelector('.w-grip')?.setAttribute('aria-label', `Move ${title}: now column ${it.x + 1}, row ${it.y + 1}. Arrow keys move it, Shift and arrows resize it, Control Alt and arrows snap it to a side.`);
    card.querySelector('.w-resize')?.setAttribute('aria-label', `Resize ${title}: ${it.w} by ${it.h} cells. Arrow keys change it.`);
  }
  function shiftMain(rows) {
    const px = rows * m.pitchY;
    if (px === mainMargin) return;
    mainMargin = px;
    mainEl.style.marginTop = px ? `${px}px` : '';
  }
  // Put every card where `list` says (except one that is being dragged), and size the page for them.
  function place(list, except) {
    let bottom = 0;
    for (const it of list) {
      const px = WL.cellToPx(it, m);
      bottom = Math.max(bottom, px.top + px.height);
      const card = cardsById.get(it.id);
      if (!card) continue;
      setCell(card, it);
      if (it.id !== except) setBox(card, px);
    }
    boxEl().style.height = list.length ? `${Math.ceil(bottom + 32)}px` : '';
    shiftMain(WL.bannerRows(list, o));
  }
  function layoutNow() {
    view = WL.resolve(items, o);
    place(view);
    if (firstLayout && items.length) {
      firstLayout = false;
      const box = boxEl();
      box.classList.add('w-instant'); // no sliding into place on the first draw
      requestAnimationFrame(() => requestAnimationFrame(() => box.classList.remove('w-instant')));
    }
  }
  let scheduled = 0;
  function relayout() {
    if (scheduled) return;
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      if (drag || !items.length) return;
      measure();
      layoutNow();
    });
  }
  addEventListener('resize', relayout);
  if (window.ResizeObserver) new ResizeObserver(relayout).observe(mainEl);

  // The browser's list -> layout items (a card without a valid place goes in the first free spot).
  function sync(valid, cards) {
    cardsById = cards;
    const taken = [];
    const incoming = valid.map((w) => {
      const r = WL.cleanRect(w.type, w.layout);
      let rect = r;
      if (!rect) { const size = WL.DEFAULT_SIZE[w.type] || { w: 4, h: 3 }; rect = { ...WL.firstFit(taken, size), ...size }; }
      taken.push(rect);
      const snap = r ? WL.cleanSnap(w.layout?.snap) : undefined;
      return { id: w.id, type: w.type, title: w.title, ...rect, ...(snap ? { snap } : {}) };
    });
    items = incoming;
    if (optimistic) {
      const agrees = incoming.every((it) => !optimistic.map.has(it.id) || WL.encode([it]) === WL.encode([optimistic.map.get(it.id)]));
      if (agrees || Date.now() - optimistic.at > 1500) optimistic = null;
      else items = incoming.map((it) => (optimistic.map.has(it.id) ? { ...it, ...optimistic.map.get(it.id) } : it));
    }
    ensureEditButton(incoming.length);
    if (!incoming.length && editing) setEditing(false);
    measure();
    layoutNow();
  }

  // ---- the ghost: where a dragged card will land ----
  function makeGhost() {
    const g = el('div', 'w-ghost');
    g.setAttribute('aria-hidden', 'true');
    boxEl().append(g);
    return g;
  }
  function ghostTo(g, it, snap) {
    const px = WL.cellToPx(it, m);
    g.style.transform = `translate3d(${px.left}px, ${px.top}px, 0)`;
    g.style.width = `${px.width}px`;
    g.style.height = `${px.height}px`;
    if (snap) g.dataset.snap = snap; else delete g.dataset.snap;
    g.classList.toggle('snap', Boolean(snap));
  }

  // ---- committing ----
  const send = (next, id) => window.widgetAct(id, 'layout', { l: WL.encode(next) });
  function commit(next, id, message) {
    items = next.map((it) => ({ ...it }));
    optimistic = { map: new Map(next.map((it) => [it.id, { x: it.x, y: it.y, w: it.w, h: it.h, ...(it.snap ? { snap: it.snap } : {}) }])), at: Date.now() };
    view = next;
    place(next);
    if (message) say(message);
    send(next, id);
  }
  function describe(card, before, after) {
    const t = titleOf(card);
    if (after.snap && after.snap !== before.snap) return `${t} snapped to ${SNAP_WORDS[after.snap]}`;
    if (after.w !== before.w || after.h !== before.h) return `${t} resized to ${after.w} by ${after.h} cells`;
    return `${t} moved to column ${after.x + 1}, row ${after.y + 1}`;
  }
  // A keyboard or preset change: fn(view) -> the next layout.
  function keyOp(card, fn) {
    if (stacked() || drag) return;
    const id = card.dataset.id;
    const before = view.find((i) => i.id === id);
    const next = fn(view, before);
    const after = next.find((i) => i.id === id);
    if (!before || !after || WL.encode(next) === WL.encode(view)) { say(`${titleOf(card)} can’t go further that way`); return; }
    commit(next, id, describe(card, before, after));
  }

  // ---- dragging and resizing ----
  const upFns = [];
  function listen(kind) {
    const mv = (e) => onMove(e);
    const up = (e) => end(e.type === 'pointercancel');
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
    upFns.push(() => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); });
    return kind;
  }
  function begin(kind, card, e, dir) {
    if (drag || stacked()) return false;
    const id = card.dataset.id;
    const it = view.find((i) => i.id === id);
    if (!it) return false;
    drag = { kind, dir, id, card, pointerId: e.pointerId, start: { x: e.clientX, y: e.clientY }, scroll0: window.scrollY, from: WL.cellToPx(it, m), base: view.map((i) => ({ ...i })), last: e, raf: 0, key: '', preview: null, snap: null, moving: false, ghost: null };
    try { card.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer: window listeners still get it */ }
    listen(kind);
    return true;
  }
  function onMove(ev) {
    if (!drag) return;
    if (ev.buttons === 0 && ev.pointerType !== 'touch' && ev.isTrusted) { end(false); return; } // released where the page didn't see it
    drag.last = ev;
    if (!drag.raf) drag.raf = requestAnimationFrame(tick);
  }
  function tick() {
    const d = drag;
    if (!d) return;
    d.raf = 0;
    const ev = d.last;
    const dx = ev.clientX - d.start.x;
    const dy = ev.clientY - d.start.y + (window.scrollY - d.scroll0);
    if (!d.moving) {
      if (Math.hypot(dx, dy) < 5) return;
      d.moving = true;
      body.classList.add('w-dragging');
      d.card.classList.add(d.kind === 'move' ? 'lifted' : 'resizing');
      d.ghost = makeGhost();
      document.activeElement?.blur?.();
    }
    const id = d.id;
    const it = d.base.find((i) => i.id === id);
    let preview;
    let snap = null;
    if (d.kind === 'move') {
      const left = d.from.left + dx;
      const top = d.from.top + dy;
      d.card.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      const zone = WL.detectSnap({ x: ev.clientX, y: ev.clientY }, { width: window.innerWidth, height: window.innerHeight });
      if (zone && window.scrollY < m.pitchY && WL.snapRectFor(zone, it, o)) {
        snap = zone;
        preview = WL.snapMove(d.base, id, { snap: zone, frac: ev.clientY / window.innerHeight }, o);
      } else {
        preview = WL.move(d.base, id, { x: Math.round((left - m.pad) / m.pitchX), y: Math.round((top - m.top) / m.pitchY) }, o);
      }
    } else {
      let { left, top } = d.from;
      let right = left + d.from.width;
      let bottom = top + d.from.height;
      if (d.dir.includes('e')) right += dx;
      if (d.dir.includes('w')) left += dx;
      if (d.dir.includes('s')) bottom += dy;
      if (d.dir.includes('n')) top += dy;
      const minW = 2 * m.cw + WL.GAP;
      const minH = 2 * WL.ROW + WL.GAP;
      if (right - left < minW) { if (d.dir.includes('w')) left = right - minW; else right = left + minW; }
      if (bottom - top < minH) { if (d.dir.includes('n')) top = bottom - minH; else bottom = top + minH; }
      left = Math.max(m.pad, left);
      top = Math.max(m.top, top);
      right = Math.min(m.width - m.pad, right);
      d.card._pos = null; // sized by hand: the next place() must write it
      d.card.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      d.card.style.width = `${right - left}px`;
      d.card.style.height = `${bottom - top}px`;
      const x1 = Math.round((left - m.pad) / m.pitchX);
      const x2 = Math.round((right - m.pad + WL.GAP) / m.pitchX);
      const y1 = Math.round((top - m.top) / m.pitchY);
      const y2 = Math.round((bottom - m.top + WL.GAP) / m.pitchY);
      preview = WL.resize(d.base, id, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, o);
    }
    const key = WL.encode(preview);
    if (key !== d.key) {
      d.key = key;
      d.preview = preview;
      d.snap = snap;
      place(preview, id);
      ghostTo(d.ghost, preview.find((i) => i.id === id), snap);
    }
    // Near the top or bottom edge of the window while dragging: scroll.
    if (d.kind === 'move' && !snap) {
      const step = ev.clientY > window.innerHeight - 48 ? 14 : ev.clientY < 48 && window.scrollY > 0 ? -14 : 0;
      if (step) { window.scrollBy(0, step); d.raf = requestAnimationFrame(tick); }
    }
  }
  function cleanup() {
    while (upFns.length) upFns.pop()();
    const d = drag;
    if (d?.raf) cancelAnimationFrame(d.raf);
    d?.ghost?.remove();
    body.classList.remove('w-dragging');
    d?.card.classList.remove('lifted', 'resizing');
    try { d?.card.releasePointerCapture(d.pointerId); } catch { /* not captured */ }
    drag = null;
    return d;
  }
  function end(cancelled) {
    const d = drag;
    if (!d) return;
    if (!d.moving) { cleanup(); flushDeferred(); return; }
    suppress = true;
    setTimeout(() => { suppress = false; }, 60);
    const next = d.preview || d.base;
    cleanup();
    if (cancelled || WL.encode(next) === WL.encode(d.base)) {
      d.card._pos = null;
      place(d.base);
      if (cancelled) say('Move cancelled');
      flushDeferred();
      return;
    }
    const before = d.base.find((i) => i.id === d.id);
    d.card._pos = null;
    commit(next, d.id, describe(d.card, before, next.find((i) => i.id === d.id)));
    deferred = null;
  }
  function cancelDrag() {
    const d = drag;
    if (!d) return;
    cleanup();
    d.card._pos = null;
    place(d.base);
    say('Move cancelled');
    flushDeferred();
  }
  function flushDeferred() {
    if (!deferred) return;
    const list = deferred;
    deferred = null;
    window.renderWidgets(list);
  }
  // A click that ends a drag is not a click on whatever was under the pointer.
  document.addEventListener('click', (e) => { if (suppress) { e.preventDefault(); e.stopPropagation(); suppress = false; } }, true);

  // ---- edit mode ----
  function ensureEditButton(count) {
    if (!editBtn) {
      editBtn = el('button', 'w-edit-btn', 'Edit widgets');
      editBtn.type = 'button';
      editBtn.setAttribute('aria-pressed', 'false');
      editBtn.addEventListener('click', () => setEditing(!editing));
      document.querySelector('main header')?.append(editBtn);
    }
    editBtn.hidden = !count || stacked();
  }
  function setEditing(on) {
    if (on === editing || (on && stacked())) return;
    editing = on;
    body.classList.toggle('w-editing', on);
    if (editBtn) { editBtn.textContent = on ? 'Done' : 'Edit widgets'; editBtn.setAttribute('aria-pressed', String(on)); }
    for (const card of cardsById.values()) card.tabIndex = on ? 0 : -1;
    say(on ? 'Editing widgets. Drag a card to move it, or use the arrow keys. Shift and arrows resize. Control Alt and arrows snap to a side. Escape or Done to finish.' : 'Done editing widgets.');
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (drag) { e.preventDefault(); e.stopPropagation(); cancelDrag(); } else if (editing) { setEditing(false); }
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (editing && !drag && !e.target.closest?.('.w-card, .w-edit-btn')) setEditing(false);
  });

  // ---- one card's controls and gestures ----
  const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'sw'];
  function attach(card) {
    const head = card.querySelector('.w-head');
    const title = titleOf(card);
    const grip = el('button', 'w-grip');
    grip.type = 'button';
    grip.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3h.01M7.5 3h.01M4.5 6h.01M7.5 6h.01M4.5 9h.01M7.5 9h.01"/></svg>';
    grip.setAttribute('aria-label', `Move ${title}`);
    grip.title = 'Drag to move';
    head.prepend(grip);
    const corner = el('button', 'w-resize');
    corner.type = 'button';
    corner.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M10 5.5 5.5 10M10 8.5 8.5 10"/></svg>';
    corner.title = 'Drag to resize';
    corner.dataset.dir = 'se';
    card.append(corner);
    for (const dir of DIRS) { const h = el('div', 'w-h'); h.dataset.dir = dir; card.append(h); }
    const remove = el('button', 'w-remove');
    remove.type = 'button';
    remove.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9"/></svg>';
    remove.setAttribute('aria-label', `Remove ${title}`);
    let armed = 0;
    remove.addEventListener('click', () => {
      if (!armed) {
        armed = setTimeout(() => { armed = 0; remove.classList.remove('armed'); remove.setAttribute('aria-label', `Remove ${title}`); }, 3500);
        remove.classList.add('armed');
        remove.setAttribute('aria-label', `Confirm: remove ${title}`);
        say(`Press again to remove ${title}`);
        return;
      }
      clearTimeout(armed);
      window.widgetAct(card.dataset.id, 'remove');
    });
    const gear = el('button', 'w-gear');
    gear.type = 'button';
    gear.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="1.8"/><path d="M6 1v1.4M6 9.6V11M1 6h1.4M9.6 6H11M2.5 2.5l1 1M8.5 8.5l1 1M9.5 2.5l-1 1M3.5 8.5l-1 1"/></svg>';
    gear.setAttribute('aria-label', `Settings for ${title}`);
    gear.title = 'Settings';
    gear.addEventListener('click', () => window.widgetAct(card.dataset.id, 'configure'));
    const presets = el('div', 'w-presets');
    presets.setAttribute('role', 'group');
    presets.setAttribute('aria-label', `Size of ${title}`);
    for (const name of Object.keys(WL.PRESETS)) {
      const b = el('button', null, name[0].toUpperCase() + name.slice(1));
      b.type = 'button';
      b.addEventListener('click', () => keyOp(card, (list, it) => WL.resize(list, it.id, { x: it.x, y: it.y, ...WL.PRESETS[name] }, o)));
      presets.append(b);
    }
    card.append(remove, gear, presets);
    card.tabIndex = editing ? 0 : -1;

    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const t = e.target;
      if (t.closest('.w-h, .w-resize')) { e.preventDefault(); begin('resize', card, e, t.closest('[data-dir]').dataset.dir); return; }
      if (t.closest('.w-remove, .w-gear, .w-presets')) return;
      if (editing) { e.preventDefault(); begin('move', card, e); return; }
      if (t.closest('.w-head') && !(t.closest('a, button') && !t.closest('.w-grip'))) { begin('move', card, e); return; }
      if (t.closest('a, button, input, iframe, select, textarea')) return;
      longPress(card, e);
    });
    card.addEventListener('keydown', (e) => cardKey(e, card));
    corner.addEventListener('keydown', (e) => {
      const dx = { ArrowLeft: -1, ArrowRight: 1 }[e.key] || 0;
      const dy = { ArrowUp: -1, ArrowDown: 1 }[e.key] || 0;
      if (!dx && !dy) return;
      e.preventDefault();
      e.stopPropagation();
      keyOp(card, (list, it) => WL.resize(list, it.id, { x: it.x, y: it.y, w: it.w + dx, h: it.h + dy }, o));
    });
  }
  // Hold ~400 ms on a card: edit mode, and the same touch can start dragging at once.
  function longPress(card, e) {
    if (stacked() || drag) return;
    const start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    card.classList.add('pressing');
    let timer = 0;
    const stop = () => {
      clearTimeout(timer);
      card.classList.remove('pressing');
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', stop);
      removeEventListener('pointercancel', stop);
    };
    const mv = (ev) => { if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) stop(); };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', stop);
    addEventListener('pointercancel', stop);
    timer = setTimeout(() => {
      stop();
      setEditing(true);
      suppress = true;
      setTimeout(() => { suppress = false; }, 700);
      begin('move', card, { pointerId: start.id, clientX: start.x, clientY: start.y });
    }, 400);
  }
  function cardKey(e, card) {
    const grip = e.target.classList?.contains('w-grip');
    if (e.target !== card && !grip) return;
    if (e.key === 'Delete' && editing && e.target === card) { e.preventDefault(); card.querySelector('.w-remove').click(); return; }
    const dx = { ArrowLeft: -1, ArrowRight: 1 }[e.key] || 0;
    const dy = { ArrowUp: -1, ArrowDown: 1 }[e.key] || 0;
    if (!dx && !dy) return;
    if (!editing && !grip) return;
    e.preventDefault();
    if (e.ctrlKey && e.altKey) {
      keyOp(card, (list, it) => {
        const snap = WL.keySnap(e.key, it.snap);
        return snap ? WL.snapMove(list, it.id, { snap, frac: snap === 'bl' || snap === 'br' ? 1 : 0 }, o) : list;
      });
    } else if (e.shiftKey) {
      keyOp(card, (list, it) => WL.resize(list, it.id, { x: it.x, y: it.y, w: it.w + dx, h: it.h + dy }, o));
    } else {
      keyOp(card, (list, it) => WL.move(list, it.id, { x: it.x + dx, y: it.y + dy }, o));
    }
  }

  window.widgetGrid = { attach, sync, busy: () => Boolean(drag), defer: (list) => { deferred = list; } };
})();
