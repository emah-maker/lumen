// Tells main where the music cards' web-player slots are (.sp-web-slot, drawn by newtab-widgets.js webPlayerCard), so it can lay the player's
// native view over them (features/web-player.js). Main used to ask five times a second; now the page says so when something moved:
// a layout pass of the widget grid, a slot that changed size, a scroll, a resize, the page being edited, a dialog opening or the page being shown.
// Changes are coalesced to one measurement per frame and nothing is sent when the numbers are the same as last time. A hidden page measures and
// sends nothing (main asks once itself when the page is shown again). The message is a console message with a fixed prefix:
// a plain web page has no channel to main, and this one only moves a view over this page.
'use strict';
(() => {
  const PREFIX = 'lumen-slot-rect '; // features/web-player.js SLOT_PREFIX
  const CARDS = ['spotify', 'applemusic']; // the cards' classes (features/spotify-web.js, apple-music-web.js)
  let frame = 0;
  let last = '';
  const watched = new WeakSet();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;
  const round = (n) => Math.round(n * 10) / 10;

  function measure() {
    frame = 0;
    if (document.hidden) return;
    const blocked = document.body.classList.contains('w-editing') || Boolean(document.querySelector('.w-picker, dialog[open]'));
    const out = {};
    let any = false;
    for (const cls of CARDS) {
      const slot = blocked ? null : document.querySelector(`.w-card.${cls} .sp-web-slot`);
      if (!slot) { out[cls] = null; continue; }
      any = true;
      if (ro && !watched.has(slot)) { watched.add(slot); ro.observe(slot); }
      const r = slot.getBoundingClientRect();
      out[cls] = { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) };
    }
    const msg = JSON.stringify(out);
    if (msg === last) return;
    if (!any && last === '') { last = msg; return; } // never had a slot: nothing to say
    last = msg;
    console.debug(PREFIX + msg);
  }
  function schedule() { if (!frame && !document.hidden) frame = requestAnimationFrame(measure); }
  window.syncWebSlots = schedule; // (a redraw of the cards calls it; tests too)

  addEventListener('scroll', schedule, { capture: true, passive: true });
  addEventListener('resize', schedule, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) last = ''; else schedule(); }); // (shown again: main may have lost it, say it again)
  document.addEventListener('DOMContentLoaded', () => {
    window.widgetGrid?.onLayout(schedule);
    new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true }); // w-editing, a picker
    new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['open'], subtree: true }); // a dialog
    schedule();
  });
})();
