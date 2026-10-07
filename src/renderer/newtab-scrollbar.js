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
  const update = () => {
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
  new ResizeObserver(update).observe(document.body);
  thumb.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true; dragY = e.clientY; dragTop = se().scrollTop; root.classList.add('sb-drag'); e.preventDefault(); update();
  });
  window.addEventListener('mouseup', () => { if (!dragging) return; dragging = false; root.classList.remove('sb-drag'); update(); });
  update();
})();
