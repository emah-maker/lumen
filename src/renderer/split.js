// [split view] The divider between two pages shown side by side. The pages are native views laid over this window (main.js layout()),
// with a gap between them; the divider is drawn in that gap, here, where main says ('split:layout'). Dragging it sends the left page's share
// of the page area back; the button in its middle closes the split view.
(() => {
  const viewport = document.getElementById('viewport');
  if (!viewport || !window.browser?.onSplit) return;
  const tr = (key, fallback) => (typeof window.t === 'function' ? window.t(key) : fallback);
  const bar = document.createElement('div');
  bar.id = 'split-divider';
  bar.className = 'split-divider';
  bar.hidden = true;
  bar.tabIndex = 0;
  bar.setAttribute('role', 'separator');
  bar.setAttribute('aria-orientation', 'vertical');
  bar.setAttribute('aria-label', tr('split.divider', 'Resize split view. Drag, or use the arrow keys.'));
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'split-close';
  close.title = tr('split.close', 'Close split view');
  close.setAttribute('aria-label', tr('split.close', 'Close split view'));
  close.innerHTML = '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 1.5l5 5M6.5 1.5l-5 5"/></svg>';
  bar.append(close);
  viewport.append(bar);

  let ratio = 0.5;
  let gap = 12;
  let pending = null;
  const send = (r) => {
    ratio = r;
    pending = r;
    if (pending !== null && !send.raf) send.raf = requestAnimationFrame(() => { send.raf = 0; window.browser.setSplitRatio(pending); pending = null; });
  };
  const fromPointer = (e) => {
    const box = viewport.getBoundingClientRect();
    return (e.clientX - box.left - gap / 2) / Math.max(1, box.width - gap);
  };
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.split-close')) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('dragging');
    document.body.classList.add('split-dragging');
  });
  bar.addEventListener('pointermove', (e) => { if (bar.hasPointerCapture(e.pointerId)) send(fromPointer(e)); });
  const end = (e) => {
    if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
    bar.classList.remove('dragging');
    document.body.classList.remove('split-dragging');
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', (e) => { if (!e.target.closest('.split-close')) send(0.5); }); // back to an even split
  bar.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft') { e.preventDefault(); send(ratio - step); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); send(ratio + step); }
    else if (e.key === 'Home') { e.preventDefault(); send(0.5); }
  });
  close.addEventListener('click', () => window.browser.closeSplit());

  window.browser.onSplit((msg) => {
    bar.hidden = !msg;
    document.body.classList.toggle('split-view', Boolean(msg));
    if (!msg) return;
    ratio = msg.ratio;
    gap = msg.width;
    bar.style.left = `${msg.x}px`;
    bar.style.width = `${msg.width}px`;
    bar.setAttribute('aria-valuenow', String(Math.round(msg.ratio * 100)));
  });
})();
