// [widgets] Smart Stack: several widgets in one place, shown one at a time (features/widget-stacks.js has the
// model, features/widgets.js stores it, features/widget-stack-motion.js has the plain logic of the motion, the
// auto-rotate timing and the smart picks). Every member gets a card; only the shown one is on the grid
// (newtab-widgets-grid.js), the others wait under it, hidden and inert, at the same cells, so a switch is
// instant and a web page's frame never reloads. Only the shown card and its two neighbors are drawn (the rest
// are content-visibility: hidden); each widget still refreshes on its own schedule.
//
// Cycling, like iOS: the mouse wheel or a two-finger swipe (deltaY) and a one-finger swipe on touch move the
// shown card with the hand, then a spring takes it to the next card (or back), carrying the release velocity;
// grabbing it mid-flight takes over from where it is. The motion is Smart Stack's: a full card slides up and
// out while the next one comes up from below, edge to edge, inside the stack's own frame (each card is clipped
// to it, so nothing leaks over a neighbor), with overlapping opacity and a slight recede (transform, opacity and
// clip-path only; a plain crossfade with Reduce motion, nothing in Performance mode). A switch changes the
// stack's classes in place: the grid is not drawn again (features/widget-stack-motion.js slide).
// Wrapping: the last card is followed by the first. At an end a swipe meets resistance first (a rubber band, and a
// firmer push to wrap); keys, dots, arrows and the auto-rotate wrap freely.
// The stack's rail on the right edge (in its own gutter of the card's padding) has page dots (buttons) and, on
// hover or focus, an up and a down arrow. It is faint at rest and shows fully on hover, focus and while the stack
// moves. The rail is the focusable stack: Up/Down and PageUp/PageDown switch, Home and End go to the ends, and
// Enter, the Menu key, a right-click or a long-press opens "Edit stack…" (so does the stack button in the card's header).
//
// A stack rotates by itself (every ~20 s, while the page is visible and nobody is hovering, focusing or
// touching it; never with Reduce motion) unless its "Rotate automatically" is off. "Smart rotate" shows the
// calendar when an event starts within 30 minutes, a countdown within a day, the weather in the morning, and
// says why for a few seconds. The "Edit stack" panel (Edit layout, the badge on a card) lists the members:
// reorder (drag or the arrows), remove, add, the two toggles; it sits beside the stack (never over it) and opens outside Edit layout too. Every change there and stacking by dropping a
// card on another can be undone (the Undo toast: newtab-edit.js). The shown member and the order are stored
// (do=cycle, do=restack) so every new tab shows the same.
(() => {
  const ST = window.WidgetStacks;
  const SM = window.WidgetStackMotion;
  const box = () => document.getElementById('widgets');
  const say = (t) => window.widgetAnnounce?.(t);
  const txt = (key, vars) => window.WidgetEdit.text(key, vars, window.lumenI18n?.strings);
  const PENDING_MS = 2500; // how long a switch the browser hasn't confirmed yet is kept on screen
  const PX_MAX = 160; // px of wheel that move one card (less for a short card: its own height)
  const LONG_PRESS_MS = 520; // a press on the rail this long opens Edit stack…
  const RAIL_MS = 1400; // the rail stays fully visible this long after a switch
  const TOUCH_HOLD_MS = 30000; // after a person touched a stack, smart rotate leaves it be this long
  const pending = new Map(); // member id -> when it was picked (until the browser's list agrees)
  const runs = new Map(); // stack id -> { last (ms of the last move or touch), seen (the last smart key acted on) }
  let groups = new Map(); // widget id -> { sid, members: [ids], top, rotate, smart }
  let lastRaw = [];
  let eng = null; // the swipe or switch in progress: { sid, topId, p (drawn), raw (swipe, before resistance), edge, v, target, jump, samples, raf, h, px }
  let endCarry = null; // { sid, raw, t }: a wheel notch that met the end of a stack and sprang back, kept for the next one
  let expecting = null; // Add widget > Smart Stack was chosen: { sids: the stacks there were, until }, so the new one's panel opens

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  // Small line icons, built with DOM calls (no markup strings).
  const SVG = 'http://www.w3.org/2000/svg';
  const ICON_STACK = ['M3.5 4.5h4a1.2 1.2 0 0 1 1.2 1.2v3.1a1.2 1.2 0 0 1-1.2 1.2h-4a1.2 1.2 0 0 1-1.2-1.2V5.7a1.2 1.2 0 0 1 1.2-1.2Z', 'M4.5 2.5h4a1 1 0 0 1 1 1v3.5'];
  const ICON_UP = ['M3 7.5 6 4.5l3 3'];
  const ICON_DOWN = ['M3 4.5 6 7.5l3-3'];
  const ICON_GRIP = ['M4.5 3.5h0M7.5 3.5h0M4.5 6h0M7.5 6h0M4.5 8.5h0M7.5 8.5h0'];
  const ICON_CLOSE = ['m3 3 6 6M9 3 3 9'];
  function icon(paths) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) { const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); svg.append(p); }
    return svg;
  }
  const cardOf = (id) => box()?.querySelector(`:scope > .w-card[data-id="${CSS.escape(id)}"]`);
  const titleOf = (card) => card?.getAttribute('aria-label') || 'Widget';
  const titleOfId = (id) => titleOf(cardOf(id));
  const rawOf = (id) => lastRaw.find((w) => w.id === id);
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const calm = () => document.body.classList.contains('calm');
  const editing = () => Boolean(window.widgetGrid?.isEditing());
  const uniqueGroups = () => [...new Set(groups.values())];
  const run = (sid) => { if (!runs.has(sid)) runs.set(sid, { last: Date.now(), touch: 0, seen: '' }); return runs.get(sid); };
  const moved = (sid) => { if (sid) run(sid).last = Date.now(); }; // the stack switched (auto-rotate counts from here)
  const touched = (sid) => { if (sid) { const r = run(sid); r.last = r.touch = Date.now(); } }; // a person used it (smart rotate leaves it be for a while)

  // The browser's list -> the same list with each stack's shown member decided (a switch just made here
  // wins until the browser agrees), limited to `max` places plus the hidden members of those places.
  function prepare(list, max) {
    lastRaw = list;
    const ids = new Set(list.map((w) => w.id));
    const next = new Map();
    const now = Date.now();
    for (const w of list) {
      if (next.has(w.id) || !Array.isArray(w.stack)) continue;
      const members = w.stack.filter((id, i, a) => typeof id === 'string' && ids.has(id) && a.indexOf(id) === i);
      if (members.length < 2 || !members.includes(w.id)) continue;
      const told = members.find((id) => list.find((x) => x.id === id).top) || members[0];
      let top = told;
      const picked = members.filter((id) => pending.has(id)).sort((a, b) => pending.get(b) - pending.get(a))[0];
      if (picked) {
        if (picked === told || now - pending.get(picked) > PENDING_MS) for (const id of members) pending.delete(id);
        else top = picked;
      }
      const g = { sid: w.sid || members.join(), members, top, rotate: w.rotate !== false, smart: w.smart !== false };
      for (const id of members) next.set(id, g);
    }
    groups = next;
    for (const sid of [...runs.keys()]) if (!uniqueGroups().some((g) => g.sid === sid)) runs.delete(sid);
    const shownIds = [];
    for (const w of list) {
      const g = groups.get(w.id);
      if ((!g || g.top === w.id) && shownIds.length < max) shownIds.push(w.id);
    }
    const keep = new Set(shownIds);
    return list.filter((w) => {
      const g = groups.get(w.id);
      return g ? keep.has(g.top) : keep.has(w.id);
    }).map((w) => {
      const g = groups.get(w.id);
      return g ? { ...w, stack: g.members, top: g.top === w.id } : w;
    });
  }

  // One card's stack controls, kept in step with its stack. -> whether the card is on the grid (shown).
  function decorate(card, w) {
    const g = groups.get(w.id);
    const control = card.querySelector(':scope > .w-stack');
    card.classList.toggle('in-stack', Boolean(g));
    if (!g) {
      control?.remove();
      card.querySelector(':scope > .w-head > .w-stack-open')?.remove();
      card.querySelector(':scope > .w-stack-edit')?.remove();
      card.classList.remove('w-near', 'w-peek');
      setHidden(card, false);
      return true;
    }
    const shown = g.top === w.id;
    setHidden(card, !shown);
    const n = g.members.length;
    const i = g.members.indexOf(w.id);
    const ti = g.members.indexOf(g.top);
    card.classList.toggle('w-near', n <= 3 || [1, n - 1].includes(((i - ti) % n + n) % n)); // the shown card's neighbors stay drawn
    const c = control || build(card);
    headButton(card);
    c.setAttribute('aria-label', txt('newtab.stack.label', { title: titleOf(card), n: i + 1, count: n }));
    const dots = c.querySelector('.w-stack-dots');
    const key = g.members.map((id) => `${id}:${titleOfId(id)}`).join('|');
    if (dots.dataset.key !== key) {
      dots.dataset.key = key;
      dots.replaceChildren(...g.members.map((id) => dot(card, id)));
    }
    [...dots.children].forEach((d, j) => {
      d.setAttribute('aria-current', j === ti ? 'true' : 'false');
      d.setAttribute('aria-label', txt('newtab.stack.dot', { title: titleOfId(g.members[j]), n: j + 1, count: n }));
      d.title = titleOfId(g.members[j]);
    });
    const prev = cardOf(ST.neighbour(g.members, w.id, -1));
    const next = cardOf(ST.neighbour(g.members, w.id, 1));
    c.querySelector('.w-stack-prev').title = prev ? `${txt('newtab.stack.prev')}: ${titleOf(prev)}` : txt('newtab.stack.prev');
    c.querySelector('.w-stack-next').title = next ? `${txt('newtab.stack.next')}: ${titleOf(next)}` : txt('newtab.stack.next');
    return shown;
  }
  // The card's header gets a stack button (shown on hover, like the pencil): Edit stack, outside Edit layout too.
  function headButton(card) {
    const head = card.querySelector(':scope > .w-head');
    if (!head) return;
    let b = head.querySelector(':scope > .w-stack-open');
    if (!b) {
      b = el('button', 'w-icon-btn w-stack-open');
      b.type = 'button';
      b.setAttribute('aria-haspopup', 'dialog');
      b.append(icon(ICON_STACK)); // stacked squares, not a "…": the pencil beside it edits the widget, this edits the stack
      b.addEventListener('click', (e) => { e.stopPropagation(); openPanel(card, b); });
      head.append(b);
    }
    b.setAttribute('aria-label', txt('newtab.stack.edit', { title: titleOf(card) }));
    b.title = txt('newtab.stack.edit.title');
  }
  function setHidden(card, hidden) {
    card.classList.toggle('w-under', hidden);
    card.inert = hidden;
    if (hidden) card.setAttribute('aria-hidden', 'true'); else card.removeAttribute('aria-hidden');
  }
  function navButton(card, cls, label, paths, step) {
    const b = el('button', `w-stack-nav ${cls}`);
    b.type = 'button';
    b.tabIndex = -1; // the stack itself is the tab stop: Up and Down are its keys
    b.setAttribute('aria-label', label);
    b.append(icon(paths));
    b.addEventListener('click', () => step(card));
    return b;
  }
  function dot(card, id) {
    const b = el('button', 'w-stack-dot');
    b.type = 'button';
    b.tabIndex = -1;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const g = groups.get(card.dataset.id) || groups.get(id);
      if (!g) return;
      jump(g, id);
    });
    return b;
  }
  function build(card) {
    const c = el('div', 'w-stack');
    c.setAttribute('role', 'group');
    c.setAttribute('aria-roledescription', txt('newtab.stack.role'));
    c.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown PageUp PageDown Home End Enter');
    c.tabIndex = 0;
    const up = navButton(card, 'w-stack-prev', txt('newtab.stack.prev'), ICON_UP, () => stepFrom(card, -1));
    const down = navButton(card, 'w-stack-next', txt('newtab.stack.next'), ICON_DOWN, () => stepFrom(card, 1));
    const dots = el('span', 'w-stack-dots');
    dots.setAttribute('role', 'presentation');
    const live = el('span', 'w-stack-live'); // the visible card's name, for screen readers, when it changes
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('role', 'status');
    const why = el('span', 'w-stack-why');
    why.hidden = true;
    why.setAttribute('aria-hidden', 'true'); // the live region says it
    c.append(up, dots, down, live);
    c.addEventListener('keydown', (e) => onKey(e, card));
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openRailMenu(card, c, e.clientX, e.clientY); });
    c.addEventListener('pointerdown', (e) => onRailPress(e, card, c));
    card.append(c, why);
    card.addEventListener('pointerdown', (e) => onTouchStart(e, card));
    card.addEventListener('contextmenu', (e) => onCardMenu(e, card, c)); // a right-click anywhere on the card is the rail's menu
    return c;
  }

  // ---- keys, dots and arrows ----
  function onKey(e, card) {
    const rail = e.currentTarget;
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10') || (e.key === 'Enter' && e.target === rail && !e.altKey && !e.ctrlKey && !e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      openPanel(card, rail);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const g = groups.get(card.dataset.id);
    if (!g) return;
    const n = g.members.length;
    const at = g.members.indexOf(g.top);
    const to = { ArrowUp: at - 1, PageUp: at - 1, ArrowLeft: at - 1, ArrowDown: at + 1, PageDown: at + 1, ArrowRight: at + 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    touched(g.sid);
    const id = g.members[ST.wrap(to, n)];
    if (id !== g.top) go(g, id, e.key === 'Home' ? -1 : e.key === 'End' ? 1 : to < at ? -1 : 1);
  }
  const stepFrom = (card, step) => {
    const g = groups.get(card.dataset.id);
    if (!g) return;
    touched(g.sid);
    go(g, ST.neighbour(g.members, g.top, step), step);
  };
  // A dot: the card it names, from whichever side it is on.
  function jump(g, id) {
    if (id === g.top) return;
    touched(g.sid);
    go(g, id, g.members.indexOf(id) > g.members.indexOf(g.top) ? 1 : -1);
  }
  // The old API (and the tests'): the arrow's step.
  function cycle(card, step) { stepFrom(card, step); }

  // ---- "Edit stack…" from the rail: a right-click, the Menu key or a long-press ----
  let menu = null; // { root, opener }
  function closeMenu(refocus = false) {
    if (!menu) return;
    const { root, opener } = menu;
    menu = null;
    root.remove();
    document.removeEventListener('pointerdown', menuOutside, true);
    document.removeEventListener('keydown', menuKeys, true);
    if (refocus && opener?.isConnected) opener.focus({ preventScroll: true });
  }
  function menuOutside(e) { if (menu && !menu.root.contains(e.target)) closeMenu(); }
  function menuKeys(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); } }
  function openRailMenu(card, rail, x, y) {
    closeMenu();
    closePanel(false);
    const root = el('div', 'w-stack-menu w-ui');
    root.setAttribute('role', 'menu');
    const item = el('button', 'w-stack-menu-item', txt('newtab.stack.menu'));
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.addEventListener('click', () => { closeMenu(); openPanel(card, rail); });
    root.append(item);
    document.body.append(root);
    const r = root.getBoundingClientRect();
    root.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
    root.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
    menu = { root, opener: rail };
    document.addEventListener('pointerdown', menuOutside, true);
    document.addEventListener('keydown', menuKeys, true);
    item.focus({ preventScroll: true });
  }
  // A right-click on the card's face (not on a field the person types in) opens the same menu as the rail.
  function onCardMenu(e, card, rail) {
    if (e.defaultPrevented || editing() || card.classList.contains('w-under')) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], .w-stack-edit')) return;
    e.preventDefault();
    openRailMenu(card, rail, e.clientX, e.clientY);
  }
  // A press that stays on the rail for LONG_PRESS_MS opens the panel (a touch screen has no right-click). The click that
  // would end it (a dot) is dropped.
  function onRailPress(e, card, rail) {
    if (e.button !== 0 || editing()) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const timer = setTimeout(() => {
      off();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 400);
      openPanel(card, rail);
    }, LONG_PRESS_MS);
    const move = (ev) => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) off(); };
    function off() {
      clearTimeout(timer);
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', off, true);
      removeEventListener('pointercancel', off, true);
    }
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', off, true);
    addEventListener('pointercancel', off, true);
  }

  // ---- the motion ----
  // eng.p is the progress toward the next card (positive) or the previous one (negative), in cards. The shown
  // card slides up and out (down and out going back) while its neighbor, the card under it, comes in behind it from
  // the other side, edge to edge, each clipped to the stack's frame (SM.slide has the numbers). With Reduce motion
  // nothing slides, the two crossfade. eng.raw is the swipe itself; at an end eng.p is its rubber-banded
  // version (SM.resist), elsewhere the same.
  function begin(g, extra = {}) {
    if (eng) settleNow();
    const h = cardOf(g.top)?.offsetHeight || 160;
    eng = { sid: g.sid, topId: g.top, p: 0, raw: 0, edge: false, exempt: 0, v: 0, target: null, jump: null, peekId: null, samples: [], raf: 0, t: 0, wheelTimer: 0, h, px: Math.max(80, Math.min(PX_MAX, h)), ...extra };
    flashRail(cardOf(g.top));
    return eng;
  }
  // Take over a card that is in flight: the swipe carries on from where the card is drawn.
  function grab() {
    stop();
    eng.exempt = eng.target ? Math.sign(eng.target) : eng.exempt; // a landing in progress is not held back at the end
    eng.target = null;
    eng.raw = eng.edge && !eng.exempt ? SM.unelastic(eng.p) : eng.p;
  }
  // Add a swipe of `step` cards to the raw swipe: the drawn progress follows it (resisted at an end).
  function swipe(g, step) {
    eng.raw = Math.max(-1, Math.min(1, eng.raw + step));
    const sign = Math.sign(eng.raw);
    if (eng.exempt && eng.exempt !== sign) eng.exempt = 0;
    const was = eng.edge;
    eng.edge = !eng.exempt && SM.atEnd(g.members.indexOf(g.top), g.members.length, sign);
    if (eng.edge && !was) pulseEnd(cardOf(eng.topId), sign);
    eng.p = SM.resist(eng.raw, eng.edge);
  }
  const groupOfEng = () => (eng ? groups.get(eng.topId) : null);
  function peekFor(g, sign) {
    if (eng.jump && eng.jump.dir === sign) return eng.jump.id;
    return ST.neighbour(g.members, g.top, sign);
  }
  function draw() {
    const g = groupOfEng();
    if (!g || g.top !== eng.topId) { abort(); return; }
    const sign = Math.sign(eng.p);
    const top = cardOf(eng.topId);
    const want = sign ? peekFor(g, sign) : null;
    if (eng.peekId && eng.peekId !== want) clearCard(cardOf(eng.peekId));
    eng.peekId = want;
    const peek = want ? cardOf(want) : null;
    if (!top) { abort(); return; }
    if (!peek) { clearCard(top); return; }
    const flat = reduced();
    const f = SM.slide(Math.min(Math.abs(eng.p), 1), sign, eng.h, flat);
    top.classList.add('w-moving');
    peek.classList.add('w-peek', 'w-moving');
    frame(top, f.out, flat);
    frame(peek, f.in, flat);
  }
  // One card's frame of the slide. The scale is about the card's own centre (the grid positions a card with a
  // transform, which moves the default origin), and the clip keeps it inside the stack's frame.
  function frame(card, f, flat) {
    card.style.opacity = f.opacity.toFixed(3);
    if (flat) return;
    if (!card.style.transformOrigin) {
      const [left, top, width, height] = String(card._pos || '').split(',').map(Number);
      if ([left, top, width, height].every(Number.isFinite)) card.style.transformOrigin = `${left + width / 2}px ${top + height / 2}px`;
    }
    card.style.translate = `0 ${f.ty.toFixed(2)}px`;
    card.style.scale = f.scale.toFixed(4);
    card.style.clipPath = f.clip[0] > 0.01 || f.clip[1] > 0.01 ? `inset(${f.clip[0].toFixed(2)}px -1px ${f.clip[1].toFixed(2)}px -1px round 17px)` : '';
  }
  function clearCard(card) {
    if (!card) return;
    card.classList.remove('w-peek', 'w-moving');
    for (const p of ['opacity', 'translate', 'scale', 'clip-path', 'transform-origin']) card.style.removeProperty(p);
  }
  function stop() {
    cancelAnimationFrame(eng.raf);
    clearTimeout(eng.wheelTimer);
    eng.raf = 0;
  }
  function abort() {
    if (!eng) return;
    stop();
    clearCard(cardOf(eng.topId));
    if (eng.peekId) clearCard(cardOf(eng.peekId));
    eng = null;
  }
  // Let go: the spring takes p to `target` (-1, 0 or 1) carrying the velocity v (cards per second).
  function release(target, v = 0) {
    stop();
    eng.target = target;
    eng.v = v;
    eng.t = performance.now();
    eng.from = eng.p;
    eng.t0 = eng.t;
    const flick = Math.abs(v) > 4;
    const fn = (now) => {
      if (!eng) return;
      const dt = (now - eng.t) / 1000;
      eng.t = now;
      if (reduced()) {
        const f = Math.min(1, (now - eng.t0) / 160);
        eng.p = eng.from + (eng.target - eng.from) * f;
        draw();
        if (!eng) return;
        if (f >= 1) { finish(); return; }
      } else {
        const s = SM.springStep({ x: eng.p, v: eng.v }, eng.target, dt, { response: 0.34, damping: flick ? 0.86 : 1 });
        eng.p = s.x;
        eng.v = s.v;
        draw();
        if (!eng) return;
        if (SM.settled(s, eng.target)) { eng.p = eng.target; finish(); return; }
      }
      eng.raf = requestAnimationFrame(fn);
    };
    eng.raf = requestAnimationFrame(fn);
  }
  function finish() {
    const e = eng;
    stop();
    const sign = Math.round(e.p);
    const peekId = sign ? (e.peekId || peekFor(groups.get(e.topId) || { members: [], top: e.topId }, sign)) : null;
    const g = groups.get(e.topId);
    abort();
    if (sign && peekId && g) commit(g, peekId);
  }
  // Where a switch in progress ends up when something else needs the stack now: past half way, it lands.
  function settleNow() {
    if (!eng) return;
    const e = eng;
    stop();
    const sign = Math.abs(e.p) >= 0.5 ? Math.sign(e.p) : 0;
    const g = groups.get(e.topId);
    const peekId = sign && g ? e.peekId || peekFor(g, sign) : null;
    abort();
    if (peekId && g) commit(g, peekId);
  }
  // The shown card is now `toId`: changed in place (the classes, the dots, the grid's record of what is shown), the
  // announcement, and the browser's record (do=cycle). The grid is not drawn again: the card that was under is the card
  // that is shown, at the same cells, so nothing flashes or moves.
  function commit(g, toId) {
    const fromId = g.top;
    const from = cardOf(fromId);
    const to = cardOf(toId);
    if (!to || !g.members.includes(toId) || fromId === toId) return;
    const focused = Boolean(from?.contains(document.activeElement));
    for (const id of g.members) pending.delete(id);
    pending.set(toId, Date.now());
    moved(g.sid);
    g.top = toId;
    lastRaw = lastRaw.map((w) => (g.members.includes(w.id) ? { ...w, top: w.id === toId } : w)); // a later redraw from this list agrees
    for (const id of g.members) { const c = cardOf(id); if (c) decorate(c, { id }); }
    window.widgetGrid?.swapShown?.(fromId, { id: toId, type: rawOf(toId)?.type, title: rawOf(toId)?.title }, to);
    if (focused) to.querySelector('.w-stack')?.focus({ preventScroll: true });
    flashRail(to);
    const n = g.members.length;
    const live = to.querySelector('.w-stack-live');
    if (live) {
      live.textContent = '';
      setTimeout(() => { live.textContent = txt('newtab.stack.shown', { title: titleOfId(toId), n: g.members.indexOf(toId) + 1, count: n }); }, 40);
    }
    window.widgetAct(toId, 'cycle');
  }
  // Met the end of the stack: the end dot pulses so the resistance reads as deliberate, not stuck.
  function pulseEnd(card) {
    if (!card) return;
    flashRail(card);
    card.classList.add('rail-end');
    clearTimeout(card._endT);
    card._endT = setTimeout(() => card.classList.remove('rail-end'), 650);
  }
  // The rail shows fully for a moment (iOS shows its page indicator when the page changes, then lets it fade).
  function flashRail(card) {
    if (!card) return;
    card.classList.add('rail-on');
    clearTimeout(card._railT);
    card._railT = setTimeout(() => card.classList.remove('rail-on'), RAIL_MS);
  }
  // Show `toId` in the stack (an arrow, a dot, a key, the auto-rotate): from the side `dir`.
  function go(g, toId, dir) {
    const grid = window.widgetGrid;
    if (!toId || editing() || grid?.busy()) return false;
    if (eng) settleNow();
    const live = [...groups.values()].find((x) => x.sid === g.sid) || g; // the browser's list may have moved on
    if (toId === live.top || !live.members.includes(toId)) return false;
    if (calm() || typeof requestAnimationFrame !== 'function') { commit(live, toId); return true; }
    begin(live, { jump: { id: toId, dir } });
    release(dir, 0);
    return true;
  }

  // ---- the mouse wheel and two-finger swipes ----
  let lockT = 0;
  let locked = false;
  let innerT = 0; // a card's own list was scrolling a moment ago: its end is not a switch
  function scrollsInside(target, card, dy) {
    for (let n = target; n && n !== card.parentNode; n = n.parentElement) {
      if (n.nodeType !== 1 || n.scrollHeight <= n.clientHeight + 1) continue;
      if (!/(auto|scroll)/.test(getComputedStyle(n).overflowY)) continue;
      if (dy < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1) return true;
    }
    return false;
  }
  function onWheel(e) {
    if (e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    const card = e.target.closest?.('.w-card.in-stack:not(.w-under)');
    if (!card || editing() || window.widgetGrid?.busy()) return;
    const g = groups.get(card.dataset.id);
    if (!g || g.top !== card.dataset.id) return;
    const dy = SM.wheelPx(e, card.clientHeight);
    if (!dy || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    const now = performance.now();
    if (scrollsInside(e.target, card, dy)) { innerT = now; return; }
    if (now - innerT < 220) return;
    e.preventDefault();
    if (locked) { // the tail of a swipe that already switched cards
      if (now - lockT > 140) locked = false; else { lockT = now; return; }
    }
    if (eng && eng.sid !== g.sid) settleNow();
    const back = eng && eng.edge && eng.target === 0 ? eng.releasedRaw : undefined; // springing back from an end: the next notch adds to what this one pushed
    const fresh = !eng;
    if (eng) grab(); else begin(g); // a new swipe, or the card in flight is grabbed where it is
    if (fresh && endCarry && endCarry.sid === g.sid && Date.now() - endCarry.t < 700) eng.raw = endCarry.raw; // wheel notches at an end add up until they wrap
    if (back !== undefined) eng.raw = back;
    if (fresh) endCarry = null;
    eng.drag = true;
    eng.jump = eng.jump && Math.sign(eng.p) === eng.jump.dir ? eng.jump : null;
    touched(g.sid);
    eng.samples.push({ t: now, d: dy });
    swipe(g, dy / eng.px);
    draw();
    if (!eng) return;
    if (Math.abs(eng.raw) >= 1) { // a whole card of swipe: it lands (wraps, at an end), and the rest of this swipe is ignored
      locked = true;
      lockT = now;
      eng.drag = false;
      release(Math.sign(eng.raw), SM.velocityOf(eng.samples, now) / eng.px);
      return;
    }
    clearTimeout(eng.wheelTimer);
    const owner = eng;
    eng.wheelTimer = setTimeout(() => {
      if (eng !== owner) return;
      const v = SM.velocityOf(owner.samples, owner.samples[owner.samples.length - 1].t, 120);
      owner.drag = false;
      const target = SM.settleTarget(owner.raw, v, owner.px, owner.edge);
      owner.releasedRaw = owner.raw;
      endCarry = owner.edge && target === 0 && Math.abs(owner.raw) > 0.05 ? { sid: g.sid, raw: owner.raw, t: Date.now() } : null; // the next notch at this end adds to this one
      release(target, v / owner.px);
    }, 90);
  }

  // ---- touch: a one-finger swipe up or down on the card ----
  let touch = null;
  function onTouchStart(e, card) {
    if (e.pointerType === 'mouse' || e.button !== 0 || touch || editing() || window.widgetGrid?.busy() || card.classList.contains('w-under')) return;
    if (e.target.closest?.('.w-head, input, select, textarea, iframe, .w-stack-edit')) return;
    const g = groups.get(card.dataset.id);
    if (!g || g.top !== card.dataset.id) return;
    touch = { id: e.pointerId, x: e.clientX, y: e.clientY, lastY: e.clientY, g, card, on: false, moved: false };
    if (eng && eng.sid === g.sid) { grab(); eng.drag = true; touch.grab = true; } // grabbing a card in flight
    addEventListener('pointermove', onTouchMove, true);
    addEventListener('pointerup', onTouchEnd, true);
    addEventListener('pointercancel', onTouchEnd, true);
  }
  function onTouchMove(e) {
    if (!touch || e.pointerId !== touch.id) return;
    const dx = e.clientX - touch.x;
    const dy = e.clientY - touch.y;
    if (!touch.on) {
      if (!touch.grab && Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      if (!touch.grab && Math.abs(dx) > Math.abs(dy)) { endTouchListeners(); touch = null; return; }
      touch.on = true;
      touch.px = touch.card.clientHeight || PX_MAX; // the card follows the finger one to one
      if (!eng) { begin(touch.g); eng.drag = true; }
      try { touch.card.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
    }
    e.preventDefault();
    touch.moved = true;
    touched(touch.g.sid);
    const step = touch.lastY - e.clientY; // an upward swipe is toward the next card
    touch.lastY = e.clientY;
    eng.samples.push({ t: performance.now(), d: step });
    swipe(touch.g, step / touch.px);
    draw();
  }
  function onTouchEnd(e) {
    if (!touch || e.pointerId !== touch.id) return;
    const t = touch;
    touch = null;
    endTouchListeners();
    if (!t.on || !eng) return;
    eng.drag = false;
    if (t.moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 60); }
    const v = e.type === 'pointercancel' ? 0 : SM.velocityOf(eng.samples, performance.now());
    release(e.type === 'pointercancel' ? 0 : SM.settleTarget(eng.raw, v, t.px, eng.edge), v / t.px);
  }
  function endTouchListeners() {
    removeEventListener('pointermove', onTouchMove, true);
    removeEventListener('pointerup', onTouchEnd, true);
    removeEventListener('pointercancel', onTouchEnd, true);
  }
  let suppressClick = false;
  document.addEventListener('click', (e) => { if (suppressClick) { e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('wheel', onWheel, { passive: false });

  // ---- by itself: auto-rotate and smart rotate ----
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function whyChip(sid, card, reason) {
    const why = card?.querySelector(':scope > .w-stack-why');
    if (!why) return;
    const label = txt(`newtab.stack.why.${reason}`);
    why.textContent = txt('newtab.stack.why', { why: label });
    why.hidden = false;
    clearTimeout(why._t);
    why._t = setTimeout(() => { why.hidden = true; }, 6000);
    const live = card.querySelector('.w-stack-live');
    if (live) setTimeout(() => { live.textContent = `${titleOf(card)}. ${txt('newtab.stack.why', { why: label })}`; }, 80);
  }
  function tick() {
    if (document.hidden || eng || touch || !groups.size || editing()) return;
    const now = new Date();
    const ms = now.getTime();
    for (const g of uniqueGroups()) {
      const card = cardOf(g.top);
      if (!card) continue;
      const r = run(g.sid);
      const held = card.matches(':hover') || card.contains(document.activeElement) || Boolean(panel && panel.sid === g.sid);
      if (held) r.last = ms; // hovering or focusing pauses it, and it waits its full turn after you leave
      if (g.smart) {
        const items = lastRaw.filter((w) => g.members.includes(w.id)).map((w) => ({ id: w.id, type: w.type, data: w.data }));
        const pick = SM.smartPick({ items, now: ms, hour: now.getHours(), day: dayKey(now) });
        const act = SM.smartAction(pick, { top: g.top, seen: r.seen, paused: held || ms - r.touch < TOUCH_HOLD_MS });
        if (act.mark) r.seen = pick.key;
        if (act.move && go(g, pick.id, g.members.indexOf(pick.id) > g.members.indexOf(g.top) ? 1 : -1)) {
          setTimeout(() => whyChip(g.sid, cardOf(pick.id), pick.reason), 320);
          continue;
        }
        if (act.mark && !act.move) whyChip(g.sid, card, pick.reason);
      }
      const plan = SM.autoPlan({ rotate: g.rotate, count: g.members.length, hidden: document.hidden, hovered: card.matches(':hover'), focused: held, reduced: reduced(), calm: calm(), editing: editing(), busy: Boolean(eng), now: ms, last: r.last });
      if (plan.run && plan.wait === 0) go(g, ST.neighbour(g.members, g.top, 1), 1);
    }
  }
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const r of runs.values()) r.last = Date.now(); }); // a stack waits its turn again after the page was away

  // ---- after every layout: hidden members sit where their shown card is; Edit layout's badges ----
  function afterLayout() {
    for (const [id, g] of groups) {
      if (g.top === id) continue;
      const card = cardOf(id);
      const top = cardOf(g.top);
      if (!card || !top) continue;
      card.style.transform = top.style.transform;
      card.style.width = top.style.width;
      card.style.height = top.style.height;
      card._pos = top._pos; // the grid's own record of what it wrote (newtab-widgets-grid.js setBox)
      card._cell = null;
      if (top.dataset.span) card.dataset.span = top.dataset.span;
      const frame = card.querySelector('.w-frame');
      const h = top.querySelector('.w-frame')?.dataset.h;
      if (frame && h) frame.dataset.h = h;
    }
    if (document.body.classList.contains('w-editing')) editBadges();
    openNew();
    noticeIntro();
    if (panel) refreshPanel();
  }
  // What the page knows as a list the model can check: the places on the grid and the hidden members.
  function pageList() {
    const items = window.widgetGrid?.items() || [];
    const out = items.map((it) => ({ id: it.id, type: it.type, x: it.x, y: it.y, w: it.w, h: it.h, ...(groups.has(it.id) ? { stack: groups.get(it.id).sid, top: true } : {}) }));
    for (const [id, g] of groups) {
      if (g.top === id) continue;
      const top = out.find((o) => o.id === g.top);
      if (top) out.push({ ...top, id, type: rawOf(id)?.type || top.type, top: false });
    }
    return out;
  }
  const canStack = (id, onto) => ST.canStack(pageList(), id, onto, window.WidgetLayout);
  // The places `id` could be stacked onto, nearest first (centre to centre).
  function candidatesFor(id) {
    const list = pageList();
    const me = list.find((it) => it.id === id);
    if (!me) return [];
    return list
      .filter((it) => !ST.isHidden(it) && ST.canStack(list, id, it.id, window.WidgetLayout) && !(groups.has(it.id) && groups.get(it.id).top !== it.id))
      .sort((a, b) => Math.hypot(a.x + a.w / 2 - (me.x + me.w / 2), a.y + a.h / 2 - (me.y + me.h / 2)) - Math.hypot(b.x + b.w / 2 - (me.x + me.w / 2), b.y + b.h / 2 - (me.y + me.h / 2)))
      .map((it) => it.id);
  }
  function editBadges() {
    for (const card of box()?.querySelectorAll(':scope > .w-card:not(.sys):not(.w-under)') || []) {
      const id = card.dataset.id;
      const g = groups.get(id);
      const can = g || candidatesFor(id).length > 0;
      let b = card.querySelector(':scope > .w-stack-edit');
      if (!can) { b?.remove(); continue; }
      if (!b) {
        b = el('button', 'w-stack-edit');
        b.type = 'button';
        b.setAttribute('aria-haspopup', 'dialog');
        b.addEventListener('click', () => openPanel(card, b));
        card.append(b);
      }
      const title = titleOf(card);
      if (b.dataset.mode !== (g ? 'edit' : 'make')) {
        b.dataset.mode = g ? 'edit' : 'make';
        b.replaceChildren(icon(ICON_STACK));
      }
      b.setAttribute('aria-label', g ? txt('newtab.stack.edit', { title }) : txt('newtab.stack.make', { title }));
      b.title = g ? txt('newtab.stack.edit.title') : txt('newtab.stack.make.title');
    }
  }

  // ---- changes, with Undo ----
  // The arrangement of the widgets `ids` as the browser's list has it now (in the order given): what Undo
  // sends back (do=restack) and what the panel sends to reorder or set an option.
  function arrangement(ids, change = {}) {
    const out = [];
    for (const id of ids) {
      const raw = rawOf(id);
      const g = groups.get(id);
      if (!raw) continue;
      const e = { id };
      const L = raw.layout;
      if (L && [L.x, L.y, L.w, L.h].every(Number.isInteger)) Object.assign(e, { x: L.x, y: L.y, w: L.w, h: L.h });
      if (L?.snap) e.snap = L.snap;
      if (g) {
        e.stack = g.sid;
        if (raw.was) e.was = raw.was;
        if (g.top === id) e.top = true;
        if (!(change.rotate ?? g.rotate)) e.rotate = false;
        if (!(change.smart ?? g.smart)) e.smart = false;
      }
      out.push(e);
    }
    return out;
  }
  const withMembers = (id) => (groups.has(id) ? groups.get(id).members : [id]);
  // Record Undo for a change to the widgets `ids`, then say so.
  function record(id, ids, message) {
    const before = arrangement(ids);
    window.widgetEditUI?.stackChanged({ id, title: titleOfId(id), before, message });
    say(message);
  }
  const send = (entries) => { if (entries.length) window.widgetAct(entries[0].id, 'restack', { s: JSON.stringify(entries) }); };
  // Undo: the arrangement from before goes back.
  function restore(entry) {
    if (!entry?.before?.length) return false;
    for (const e of entry.before) pending.delete(e.id);
    send(entry.before);
    return true;
  }
  // `id` (with its stack) stacked onto `onto`: dropped on it in Edit layout, or picked in the panel.
  function join(id, onto, anchored = false) { // anchored: the stack keeps `id`'s place and size (started from its panel)
    const ids = [...new Set([...withMembers(id), ...withMembers(onto)])];
    if (!groups.has(id) && !groups.has(onto)) watchIntro(); // a new stack (not one more card in a stack)
    record(id, ids, txt('newtab.edit.stacked', { title: titleOfId(id), onto: titleOfId(onto) }));
    window.widgetAct(id, 'stack', anchored ? { onto, anchor: id } : { onto });
  }
  function leave(id) {
    record(id, withMembers(id), txt('newtab.edit.unstacked', { title: titleOfId(id) }));
    window.widgetAct(id, 'unstack');
  }
  function reorder(g, id, to) {
    const ids = g.members.slice();
    const from = ids.indexOf(id);
    const at = Math.max(0, Math.min(ids.length - 1, to));
    if (from < 0 || from === at) return;
    record(id, ids, txt('newtab.stack.reordered', { title: titleOfId(id), n: at + 1, count: ids.length }));
    ids.splice(at, 0, ids.splice(from, 1)[0]);
    send(arrangement(ids));
  }
  function setOption(g, key, on) {
    const word = txt(on ? 'newtab.stack.on' : 'newtab.stack.off');
    record(g.top, g.members, txt('newtab.stack.option', { option: txt(`newtab.stack.${key}`), state: word }));
    send(arrangement(g.members, { [key]: on }));
  }

  // ---- the Edit stack panel ----
  let panel = null; // { sid, card, opener, root, key }
  function closePanel(refocus = true) {
    if (!panel) return;
    const { root, opener } = panel;
    panel = null;
    root.remove();
    document.removeEventListener('keydown', panelKeys, true);
    document.removeEventListener('pointerdown', panelOutside, true);
    if (refocus && opener?.isConnected) opener.focus({ preventScroll: true });
  }
  function panelKeys(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePanel(); }
  }
  function panelOutside(e) {
    if (panel && !panel.root.contains(e.target) && !e.target.closest?.('.w-stack-edit, .w-stack-open, .w-stack-menu, .w-toast')) closePanel(false);
  }
  function openPanel(card, opener) {
    if (panel && panel.card === card) { closePanel(); return; }
    closeMenu();
    closePanel(false);
    card.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const root = el('div', 'w-stack-panel w-ui');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', txt('newtab.stack.panel'));
    document.body.append(root);
    panel = { sid: groups.get(card.dataset.id)?.sid || null, id: card.dataset.id, card, opener, root, key: '' };
    document.addEventListener('keydown', panelKeys, true);
    document.addEventListener('pointerdown', panelOutside, true);
    refreshPanel(true);
  }
  const typeLabel = (type) => { const info = window.WidgetEdit.TYPE_INFO[type]; return info ? txt(info[0]) : type; };
  const panelSignature = (g, id) => (g
    ? `s|${g.sid}|${g.members.map((m) => `${m}:${titleOfId(m)}`).join()}|${g.rotate}|${g.smart}|${candidatesFor(g.top).filter((c) => !groups.has(c)).join()}`
    : `p|${id}|${candidatesFor(id).join()}`);
  // Beside the stack it edits, never over it: the side with the least of the other cards under it (and clear of the
  // toolbar and the picker). features/widget-edit.js placePanel has the rule; an Undo toast moves out of its way.
  function placePanel() {
    const rect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    const own = rect(panel.card);
    const others = [...(box()?.querySelectorAll(':scope > .w-card:not(.w-under)') || []), ...document.querySelectorAll('main #clock:not([hidden]), main form')].filter((c) => c !== panel.card).map(rect); // the other cards and the clock and search bar
    const avoid = [...document.querySelectorAll('.w-dock:not([hidden]), .w-picker')].filter((n) => n.getClientRects().length).map(rect);
    panel.root.style.maxHeight = `${Math.max(160, Math.min(560, innerHeight * 0.8, innerHeight - 16))}px`;
    const size = { w: panel.root.offsetWidth || 300, h: panel.root.offsetHeight || 320 };
    const at = window.WidgetEdit.placePanel({ size, view: { w: innerWidth, h: innerHeight }, own, others, avoid });
    panel.root.style.left = `${Math.round(at.left)}px`;
    panel.root.style.top = `${Math.round(at.top)}px`;
    panel.root.dataset.side = at.side;
    window.widgetEditUI?.placeToast?.();
    // A card that was just made or moved is still sliding into its place (260 ms): measure again once it has landed.
    if (!panel.rechecked) {
      const mine = panel;
      mine.rechecked = true;
      setTimeout(() => { if (panel === mine) placePanel(); }, 330);
    }
  }
  function refreshPanel(first = false) {
    if (!panel) return;
    // The card the panel is about may have been shown or hidden: follow the stack it is in.
    const g = groups.get(panel.id) || (panel.sid ? uniqueGroups().find((x) => x.sid === panel.sid) : null);
    if (!g && panel.sid) { closePanel(); return; } // the stack is gone
    if (g) panel.card = cardOf(g.top) || panel.card;
    const sig = panelSignature(g, panel.id);
    if (!first && sig === panel.key) { placePanel(); return; }
    panel.key = sig;
    const had = panel.root.contains(document.activeElement) ? document.activeElement.dataset?.focus : null;
    panel.root.replaceChildren(g ? stackSection(g) : makeSection(panel.id));
    const again = had ? panel.root.querySelector(`[data-focus="${CSS.escape(had)}"]`) : null;
    (again || panel.root.querySelector('[data-focus]'))?.focus({ preventScroll: true });
    placePanel();
  }
  function head(title, hint) {
    const h = el('div', 'w-sp-head');
    h.append(el('h2', null, title));
    const done = el('button', 'w-sp-done', txt('newtab.stack.done'));
    done.type = 'button';
    done.dataset.focus = 'done';
    done.addEventListener('click', () => closePanel());
    h.append(done);
    const wrap = el('div');
    wrap.append(h);
    if (hint) wrap.append(el('p', 'w-sp-hint', hint));
    return wrap;
  }
  // What joining does to sizes: '' when `id` already has the place's size, else a short note ("Resizes to 3×3", or
  // "Stack grows to 3×3" when a kind needs more than the stack has). `into` is a shown card of the place it joins.
  function sizeNote(id, into, anchored = false) {
    const WL = window.WidgetLayout;
    const list = pageList();
    const a = list.find((it) => it.id === id);
    const b = list.find((it) => it.id === into);
    if (!WL || !a || !b || ST.stackBlock(list, id, into, WL)) return '';
    const ids = [...new Set([...withMembers(id), ...withMembers(into)])];
    const base = anchored ? a : b; // the stack takes the size of the card it is started from (anchored), else of the stack it joins
    const size = ST.stackSize(list, ids, base, WL);
    const picked = anchored ? b : a; // the widget the row names: the one whose size changes
    const fmt = (s) => `${s.w}×${s.h}`;
    if (size.w !== base.w || size.h !== base.h) return txt('newtab.stack.grows', { size: fmt(size) });
    return picked.w !== size.w || picked.h !== size.h ? txt('newtab.stack.fits', { size: fmt(size) }) : '';
  }
  function pickRow(id, label, onPick, note = '') {
    const b = el('button', 'w-sp-pick');
    b.type = 'button';
    b.dataset.focus = `pick-${id}`;
    b.append(el('b', null, titleOfId(id)), el('span', null, note ? `${typeLabel(rawOf(id)?.type)} · ${note}` : typeLabel(rawOf(id)?.type)));
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onPick);
    return b;
  }
  // A card that is no stack yet: the widgets of its size it can start one with.
  function makeSection(id) {
    const s = el('div');
    s.append(head(txt('newtab.stack.new'), txt('newtab.stack.new.hint')));
    const ids = candidatesFor(id);
    if (!ids.length) s.append(el('p', 'w-sp-none', txt('newtab.stack.new.none')));
    for (const onto of ids) {
      s.append(pickRow(onto, txt('newtab.stack.new.one', { title: titleOfId(id), onto: titleOfId(onto) }), () => {
        join(id, onto, true);
        closePanel();
      }, sizeNote(id, onto, true)));
    }
    return s;
  }
  function stackSection(g) {
    const s = el('div');
    s.append(head(txt('newtab.stack.panel'), txt('newtab.stack.panel.hint')));
    const list = el('div', 'w-sp-list');
    list.setAttribute('role', 'list');
    const n = g.members.length;
    g.members.forEach((id, i) => {
      const row = el('div', 'w-sp-row');
      row.setAttribute('role', 'listitem');
      row.dataset.id = id;
      if (id === g.top) row.classList.add('shown');
      const grip = el('button', 'w-sp-grip');
      grip.type = 'button';
      grip.dataset.focus = `grip-${id}`;
      grip.setAttribute('aria-label', txt('newtab.stack.grip', { title: titleOfId(id), n: i + 1, count: n }));
      grip.append(icon(ICON_GRIP));
      grip.addEventListener('pointerdown', (e) => dragRow(e, g, row, list));
      grip.addEventListener('keydown', (e) => {
        const d = { ArrowUp: -1, ArrowDown: 1 }[e.key];
        if (!d || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        reorder(g, id, i + d);
      });
      const name = el('span', 'w-sp-name');
      name.append(el('b', null, titleOfId(id)), el('span', null, typeLabel(rawOf(id)?.type)));
      const up = rowButton(`up-${id}`, txt('newtab.stack.up', { title: titleOfId(id) }), ICON_UP, i === 0, () => reorder(g, id, i - 1));
      const down = rowButton(`down-${id}`, txt('newtab.stack.down', { title: titleOfId(id) }), ICON_DOWN, i === n - 1, () => reorder(g, id, i + 1));
      const gone = rowButton(`rm-${id}`, txt('newtab.stack.unstack', { title: titleOfId(id) }), ICON_CLOSE, false, () => leave(id));
      row.append(grip, name, up, down, gone);
      list.append(row);
    });
    s.append(list);
    const opts = el('div', 'w-sp-opts');
    opts.append(toggle(g, 'rotate', txt('newtab.stack.rotate'), txt('newtab.stack.rotate.hint')));
    // Smart rotate only means something with a member it can act on (weather, calendar, countdown): otherwise a hint.
    if (ST.canSmart(g.members.map((m) => rawOf(m)?.type))) opts.append(toggle(g, 'smart', txt('newtab.stack.smart'), txt('newtab.stack.smart.hint')));
    else opts.append(el('p', 'w-sp-none w-sp-smart-none', txt('newtab.stack.smart.none')));
    s.append(opts);
    const more = candidatesFor(g.top).filter((c) => !groups.has(c));
    const add = el('div', 'w-sp-add');
    add.append(el('h3', null, txt('newtab.stack.add')));
    if (n >= ST.MAX_STACK) add.append(el('p', 'w-sp-none', txt('newtab.stack.full', { max: ST.MAX_STACK })));
    else if (!more.length) add.append(el('p', 'w-sp-none', txt('newtab.stack.add.none')));
    else for (const id of more) add.append(pickRow(id, txt('newtab.stack.add.one', { title: titleOfId(id) }), () => join(id, g.top), sizeNote(id, g.top)));
    s.append(add);
    return s;
  }
  function rowButton(focus, label, paths, disabled, fn) {
    const b = el('button', 'w-sp-btn');
    b.type = 'button';
    b.dataset.focus = focus;
    b.disabled = disabled;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.append(icon(paths));
    b.addEventListener('click', fn);
    return b;
  }
  function toggle(g, key, label, hint) {
    const l = el('label', 'w-sp-toggle');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = g[key];
    input.dataset.focus = `opt-${key}`;
    input.addEventListener('change', () => setOption(g, key, input.checked));
    const t = el('span');
    t.append(el('b', null, label), el('span', null, hint));
    l.append(input, t);
    return l;
  }
  // Dragging a row by its handle: it follows the pointer, a line shows where it will land.
  function dragRow(e, g, row, list) {
    if (e.button !== 0) return;
    e.preventDefault();
    const rows = [...list.children];
    const from = rows.indexOf(row);
    const y0 = e.clientY;
    const mids = rows.map((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; });
    let to = from;
    row.classList.add('lifted');
    const move = (ev) => {
      row.style.translate = `0 ${ev.clientY - y0}px`;
      to = mids.reduce((best, m, i) => (Math.abs(ev.clientY - m) < Math.abs(ev.clientY - mids[best]) ? i : best), 0);
      rows.forEach((r, i) => r.classList.toggle('drop', i === to && to !== from));
    };
    const up = (ev) => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      removeEventListener('pointercancel', up, true);
      row.classList.remove('lifted');
      row.style.removeProperty('translate');
      rows.forEach((r) => r.classList.remove('drop'));
      if (ev.type === 'pointerup' && to !== from) reorder(g, row.dataset.id, to);
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
    addEventListener('pointercancel', up, true);
  }
  // Leaving Edit layout removes the badges (an open Edit stack panel stays: it works outside Edit layout too). Entering: badges.
  document.addEventListener('w-mode', (e) => {
    if (e.detail?.editing) editBadges(); else if (panel && !panel.sid) closePanel(false); // the "New stack" picker is part of Edit layout
    if (!e.detail?.editing) setTimeout(noticeIntro, 300); // back at rest: a stack made in Edit layout shows how it works
  });
  // ---- first use: a stack that was just made shows how it works ----
  // Once per new stack, when it is on screen at rest (after Edit layout, which hides the rail): the rail pulses and the
  // next card slides up about 12% and back, like a page turn started and thought better of. Not with Reduce motion
  // or in Performance mode; a person's own swipe takes over at once.
  const PEEK = 0.12; // of the card's height
  const PEEK_MS = 950;
  const INTRO_PULSE_MS = 1700;
  const introduced = new Set(); // stack ids already shown
  let introWatch = null; // { sids: the stacks there were, until }: a stack that is new now was just made
  let introDue = []; // stack ids waiting for the page to be at rest
  function watchIntro() { introWatch = { sids: new Set(uniqueGroups().map((g) => g.sid)), until: Date.now() + 8000 }; }
  function noticeIntro() {
    if (introWatch) {
      if (Date.now() > introWatch.until) introWatch = null;
      else {
        const fresh = uniqueGroups().find((x) => !introWatch.sids.has(x.sid) && !introduced.has(x.sid));
        if (fresh) { introduced.add(fresh.sid); introDue.push(fresh.sid); introWatch = null; }
      }
    }
    if (introDue.length && !editing()) {
      const sid = introDue.shift();
      setTimeout(() => playIntro(sid), 500); // the cards have landed
    }
  }
  function playIntro(sid) {
    if (reduced() || calm() || document.hidden) return;
    if (editing()) { introDue.push(sid); return; }
    const g = uniqueGroups().find((x) => x.sid === sid);
    const card = g && cardOf(g.top);
    if (!card || eng) return;
    card.classList.add('rail-intro');
    setTimeout(() => card.classList.remove('rail-intro'), INTRO_PULSE_MS);
    const next = ST.neighbour(g.members, g.top, 1);
    if (!next) return;
    const e = begin(g, { jump: { id: next, dir: 1 } });
    const t0 = performance.now();
    const step = (now) => {
      if (eng !== e) return; // a swipe or a key took over
      const k = Math.min(1, (now - t0) / PEEK_MS);
      e.p = PEEK * Math.sin(Math.PI * k) ** 1.5;
      draw();
      if (eng !== e) return;
      if (k >= 1) { abort(); return; }
      e.raf = requestAnimationFrame(step);
    };
    e.raf = requestAnimationFrame(step);
  }
  // Add widget > Smart Stack: the page asked the browser for a new stack; when it arrives its Edit stack panel opens.
  function expectNew() { watchIntro(); expecting = { sids: new Set(uniqueGroups().map((g) => g.sid)), until: Date.now() + 8000 }; }
  function openNew() {
    if (!expecting) return;
    if (Date.now() > expecting.until) { expecting = null; return; }
    const g = uniqueGroups().find((x) => !expecting.sids.has(x.sid));
    const card = g && cardOf(g.top);
    if (!card) return;
    expecting = null;
    openPanel(card, null);
  }

  window.widgetGrid?.onLayout(afterLayout);
  window.newtabStacks = {
    prepare, decorate, afterLayout, canStack, cycle, join, leave, restore, expectNew, edit: (id) => { const c = cardOf(groups.get(id)?.top || id); if (c && groups.has(id)) openPanel(c, null); return Boolean(panel); }, go: (id, to, dir) => { const g = groups.get(id); return g ? go(g, to, dir || 1) : false; },
    state: () => ({ groups: [...new Set(groups.values())].map((g) => ({ ...g })), pending: [...pending.keys()], moving: eng ? { sid: eng.sid, p: eng.p, peek: eng.peekId } : null, panel: Boolean(panel) }),
  };
})();
