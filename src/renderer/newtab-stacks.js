// [widgets] Stacks: several widgets of the same size in one place, shown one at a time (features/
// widget-stacks.js has the model, features/widgets.js stores it). Every member gets a card; only the
// shown one is on the grid (newtab-widgets-grid.js), the others wait under it, hidden and inert, at the
// same cells, so a switch is instant and a web page's frame never reloads.
//
// A stacked card has page dots and a small arrow in its bottom corner (the arrow shows on hover or
// focus). The arrow is a real button: a click or Enter shows the next member, Left and Right go back
// and forth while it has focus. The switch is a short crossfade and slide (a plain fade with Reduce
// motion, nothing in Performance mode), is announced, and is stored (do=cycle) so every new tab shows
// the same one. In Edit layout a card is stacked by dropping it onto a card of the same size (the
// grid), or with the stack badge (onto the nearest same-size card); the badge on a stacked card takes
// it out of the stack.
(() => {
  const ST = window.WidgetStacks;
  const box = () => document.getElementById('widgets');
  const say = (t) => window.widgetAnnounce?.(t);
  const txt = (key, vars) => window.WidgetEdit.text(key, vars, window.lumenI18n?.strings);
  const PENDING_MS = 2500; // how long a switch the browser hasn't confirmed yet is kept on screen
  const pending = new Map(); // member id -> when it was picked (until the browser's list agrees)
  let groups = new Map(); // widget id -> { members: [ids], top }
  let lastRaw = [];
  let animating = false;

  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  // Small line icons, built with DOM calls (no markup strings).
  const SVG = 'http://www.w3.org/2000/svg';
  const ICON_STACK = ['M3.5 4.5h4a1.2 1.2 0 0 1 1.2 1.2v3.1a1.2 1.2 0 0 1-1.2 1.2h-4a1.2 1.2 0 0 1-1.2-1.2V5.7a1.2 1.2 0 0 1 1.2-1.2Z', 'M4.5 2.5h4a1 1 0 0 1 1 1v3.5'];
  const ICON_UNSTACK = [ICON_STACK[0], 'M7 1l2.5 2.5M9.5 1 7 3.5'];
  function icon(paths) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) { const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); svg.append(p); }
    return svg;
  }
  const cardOf = (id) => box()?.querySelector(`:scope > .w-card[data-id="${CSS.escape(id)}"]`);
  const titleOf = (card) => card?.getAttribute('aria-label') || 'Widget';

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
      const g = { members, top };
      for (const id of members) next.set(id, g);
    }
    groups = next;
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
      card.querySelector(':scope > .w-stack-edit')?.remove();
      setHidden(card, false);
      return true;
    }
    const shown = g.top === w.id;
    setHidden(card, !shown);
    const n = g.members.length;
    const i = g.members.indexOf(w.id);
    const c = control || build(card);
    c.setAttribute('aria-label', `Widget stack, ${i + 1} of ${n}`);
    const dots = c.querySelector('.w-stack-dots');
    if (dots.childElementCount !== n) dots.replaceChildren(...g.members.map(() => el('i')));
    [...dots.children].forEach((d, j) => d.classList.toggle('on', j === i));
    const btn = c.querySelector('.w-stack-next');
    const nextCard = cardOf(ST.neighbour(g.members, w.id, 1));
    btn.title = nextCard ? `${txt('newtab.stack.next')}: ${titleOf(nextCard)}` : txt('newtab.stack.next');
    return shown;
  }
  function setHidden(card, hidden) {
    card.classList.toggle('w-under', hidden);
    card.inert = hidden;
    if (hidden) card.setAttribute('aria-hidden', 'true'); else card.removeAttribute('aria-hidden');
  }
  function build(card) {
    const c = el('div', 'w-stack');
    c.setAttribute('role', 'group');
    const dots = el('span', 'w-stack-dots');
    dots.setAttribute('aria-hidden', 'true');
    const btn = el('button', 'w-stack-next');
    btn.type = 'button';
    btn.setAttribute('aria-label', txt('newtab.stack.next'));
    btn.setAttribute('aria-keyshortcuts', 'ArrowRight ArrowLeft');
    btn.append(icon(['M4.5 2.5 8 6l-3.5 3.5']));
    btn.addEventListener('click', () => cycle(card, 1));
    btn.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!step || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      cycle(card, step);
    });
    c.append(dots, btn);
    card.append(c);
    return c;
  }

  // ---- switching ----
  const SPRING = 'linear(0, 0.18 4%, 0.5 11%, 0.78 19%, 0.94 28%, 1.015 38%, 1.02 46%, 1.008 60%, 1)'; // a quick, barely overshooting spring
  function cycle(card, step) {
    const g = groups.get(card.dataset.id);
    const grid = window.widgetGrid;
    if (!g || animating || grid?.isEditing() || grid?.busy()) return;
    const toId = ST.neighbour(g.members, g.top, step);
    const from = cardOf(g.top);
    const to = cardOf(toId);
    if (!toId || !from || !to) return;
    const focused = from.contains(document.activeElement);
    for (const id of g.members) pending.delete(id);
    pending.set(toId, Date.now());
    window.renderWidgets(lastRaw); // the grid now has `to` in the place; `from` waits under it
    animate(from, to, step);
    if (focused) to.querySelector('.w-stack-next')?.focus({ preventScroll: true });
    say(txt('newtab.stack.shown', { title: titleOf(to), n: g.members.indexOf(toId) + 1, count: g.members.length }));
    window.widgetAct(toId, 'cycle');
  }
  function animate(from, to, step) {
    const body = document.body;
    if (body.classList.contains('calm') || typeof to.animate !== 'function') return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dx = reduce ? 0 : 12 * Math.sign(step);
    animating = true;
    from.classList.add('w-leaving');
    const into = to.animate(
      [{ opacity: 0, translate: `${dx}px 0`, scale: reduce ? 1 : 0.985 }, { opacity: 1, translate: '0 0', scale: 1 }],
      { duration: reduce ? 140 : 240, easing: reduce ? 'linear' : SPRING },
    );
    const out = from.animate(
      [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: `${-dx}px 0` }],
      { duration: reduce ? 140 : 170, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
    );
    const done = () => { from.classList.remove('w-leaving'); animating = false; };
    Promise.all([into.finished, out.finished]).then(done, done);
  }

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
  }
  // What the page knows as a list the model can check: the places on the grid and the hidden members.
  function pageList() {
    const items = window.widgetGrid?.items() || [];
    const out = items.map((it) => ({ id: it.id, type: it.type, x: it.x, y: it.y, w: it.w, h: it.h, ...(groups.has(it.id) ? { stack: groups.get(it.id).members.join(), top: true } : {}) }));
    for (const [id, g] of groups) {
      if (g.top === id) continue;
      const top = out.find((o) => o.id === g.top);
      if (top) out.push({ ...top, id, type: cardOf(id)?.classList[1] || top.type, top: false });
    }
    return out;
  }
  const canStack = (id, onto) => ST.canStack(pageList(), id, onto);
  // The nearest card `id` could be stacked onto (centre to centre), or null.
  function nearestFor(id) {
    const list = pageList();
    const me = list.find((it) => it.id === id);
    if (!me) return null;
    let best = null;
    let bestD = Infinity;
    for (const it of list) {
      if (ST.isHidden(it) || !ST.canStack(list, id, it.id) || (groups.has(it.id) && groups.get(it.id).top !== it.id)) continue;
      const d = Math.hypot(it.x + it.w / 2 - (me.x + me.w / 2), it.y + it.h / 2 - (me.y + me.h / 2));
      if (d < bestD) { bestD = d; best = it.id; }
    }
    return best;
  }
  function editBadges() {
    for (const card of box()?.querySelectorAll(':scope > .w-card:not(.sys):not(.w-under)') || []) {
      const id = card.dataset.id;
      const g = groups.get(id);
      const onto = g ? null : nearestFor(id);
      let b = card.querySelector(':scope > .w-stack-edit');
      if (!g && !onto) { b?.remove(); continue; }
      if (!b) {
        b = el('button', 'w-stack-edit');
        b.type = 'button';
        b.addEventListener('click', () => badge(card));
        card.append(b);
      }
      const title = titleOf(card);
      const mode = g ? 'unstack' : 'stack';
      if (b.dataset.mode !== mode) {
        b.dataset.mode = mode;
        b.replaceChildren(icon(g ? ICON_UNSTACK : ICON_STACK));
      }
      const ontoTitle = onto ? titleOf(cardOf(onto)) : '';
      b.setAttribute('aria-label', g ? txt('newtab.stack.unstack', { title }) : txt('newtab.stack.onto', { title, onto: ontoTitle }));
      b.title = g ? txt('newtab.stack.unstack.title') : txt('newtab.stack.onto.title', { onto: ontoTitle });
    }
  }
  function badge(card) {
    const id = card.dataset.id;
    const title = titleOf(card);
    if (groups.has(id)) {
      say(txt('newtab.edit.unstacked', { title }));
      window.widgetAct(id, 'unstack');
      return;
    }
    const onto = nearestFor(id);
    if (!onto) return;
    say(txt('newtab.edit.stacked', { title, onto: titleOf(cardOf(onto)) }));
    window.widgetAct(id, 'stack', { onto });
  }
  // Leaving Edit layout: no badges. Entering: badges.
  document.addEventListener('w-mode', (e) => { if (e.detail?.editing) editBadges(); });

  window.widgetGrid?.onLayout(afterLayout);
  window.newtabStacks = { prepare, decorate, afterLayout, canStack, cycle, state: () => ({ groups: [...new Set(groups.values())].map((g) => ({ ...g })), pending: [...pending.keys()] }) };
})();
