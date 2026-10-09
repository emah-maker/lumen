// The new-tab page's scrollbar: an overlay thumb drawn on top of the page, fixed to the right edge (newtab.html: #sbar).
// The native scrollbar is off (it would take layout width and show as a band beside the background), so this thumb takes
// zero width and shifts nothing. It shows (html.show-scrollbar) only while the pointer is within EDGE px of the right edge,
// while the page scrolls, or while the thumb is being dragged, and fades out again. Wheel, keys and touch scrolling are
// the browser's own and never depend on it.
(() => {
  const EDGE = 16, HIDE_MS = 900;
  const root = document.documentElement;
  const bar = document.createElement('div');
  const thumb = document.createElement('div');
  bar.id = 'sbar'; thumb.id = 'sbar-thumb'; bar.setAttribute('aria-hidden', 'true');
  bar.appendChild(thumb); document.body.appendChild(bar);
  let near = false, dragging = false, scrolling = 0, dragY = 0, dragTop = 0;
  const se = () => document.scrollingElement || root;
  const metrics = () => {
    const el = se(), view = el.clientHeight, total = el.scrollHeight;
    if (total <= view + 1) return null;
    const h = Math.max(28, Math.round(view * view / total));
    return { view, total, h, range: view - h, max: total - view };
  };
  // The room kept under the centre column (main's bottom padding, newtab.html) belongs to a page that scrolls anyway:
  // while the column fits the window the page has nothing to scroll, so the padding is dropped (--main-room) and a wheel
  // over a card can never move a page that has no content below the fold. (The cards' own room: newtab-widgets-grid place().)
  const ROOM = 48;
  const syncRoom = () => {
    const main = document.querySelector && document.querySelector('main'), pageRoom = window.WidgetLayout && window.WidgetLayout.pageRoom;
    if (!main || !pageRoom) return;
    const pad = parseFloat(getComputedStyle(main).paddingBottom) || 0;
    const room = pageRoom(main.offsetTop + main.offsetHeight - pad, root.clientHeight, ROOM);
    if (room !== pad) main.style.setProperty('--main-room', room + 'px');
  };
  const update = () => {
    syncRoom();
    const m = metrics();
    if (!m) { thumb.style.display = 'none'; root.classList.remove('show-scrollbar'); return; }
    thumb.style.display = '';
    thumb.style.height = m.h + 'px';
    thumb.style.top = Math.round(se().scrollTop / m.max * m.range) + 'px';
    root.classList.toggle('show-scrollbar', near || dragging || scrolling > 0);
  };
  document.addEventListener('mousemove', (e) => {
    if (dragging) { const m = metrics(); if (m) se().scrollTop = dragTop + (e.clientY - dragY) / m.range * m.max; return; }
    const n = e.clientX >= root.clientWidth - EDGE;
    if (n !== near) { near = n; update(); }
  }, true);
  document.addEventListener('mouseleave', () => { near = false; update(); });
  window.addEventListener('blur', () => { near = false; dragging = false; root.classList.remove('sb-drag'); update(); });
  document.addEventListener('scroll', () => {
    scrolling++; update();
    setTimeout(() => { scrolling = Math.max(0, scrolling - 1); update(); }, HIDE_MS);
  }, { passive: true });
  window.addEventListener('resize', update);

  // Scroll chaining. A card's own scrolling area (a task list, a calendar, a feed, a music list) that has reached its end must
  // not hand the wheel on to the page: the page would then scroll although the pointer is on the card. This is done here rather
  // than with overscroll-behavior: that CSS also stops a wheel over an area that does not scroll at all (an overflow-hidden card)
  // from reaching a page that really is tall. Only an area that scrolls, and is at its end in the wheel's direction, absorbs it.
  // (Runs after the stacks' own wheel handler, newtab-stacks.js, which has already taken the wheels that switch cards.)
  const absorbs = (target, dy, style) => {
    let found = false; // some scrolling area is under the pointer, and every one of them is at its end
    for (let n = target; n && n.nodeType === 1 && n !== document.body && n !== root; n = n.parentElement) {
      if (n.scrollHeight <= n.clientHeight + 1 || !/(auto|scroll)/.test(style(n).overflowY)) continue;
      const room = dy < 0 ? n.scrollTop : n.scrollHeight - n.clientHeight - n.scrollTop;
      if (room >= 1) return false; // it scrolls (or hands the wheel to an outer area that does)
      found = true;
    }
    return found;
  };
  window.newtabWheelAbsorbs = absorbs;
  document.addEventListener('wheel', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || !e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // (Ctrl + wheel is the page zoom)
    if (absorbs(e.target, e.deltaY, (n) => getComputedStyle(n))) e.preventDefault();
  }, { passive: false });
  new ResizeObserver(update).observe(document.body);
  thumb.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true; dragY = e.clientY; dragTop = se().scrollTop; root.classList.add('sb-drag'); e.preventDefault(); update();
  });
  window.addEventListener('mouseup', () => { if (!dragging) return; dragging = false; root.classList.remove('sb-drag'); update(); });
  update();
})();
