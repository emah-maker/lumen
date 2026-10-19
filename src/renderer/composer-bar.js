// The composer's toolbar under the text box: the "+" menu (screenshot of this tab, attach files, plan first) and the menu on Send's
// chevron (run in the background). The rows are the same buttons as before (#screen-btn, #attach, #plan-chip, #send-bg) with their own
// handlers (chat-core.js, plan-mode.js, tasks.js); this file only opens and closes the two menus, moves focus with the arrow keys,
// and mirrors their state where it must stay in sight: a dot on "+" while the screenshot is on, the Plan tag, the chevron's presence.
// Used by the sidebar and by lumen://chat (which has no screenshot or background row).
(() => {
  const byId = (id) => document.getElementById(id);
  const tr = (key, fallback) => { const text = typeof window.t === 'function' ? window.t(key) : key; return text && text !== key ? text : fallback; };
  const menus = [];

  function closeAll(except) {
    for (const m of menus) if (m !== except && !m.menu.hidden) m.close(false);
  }
  function setup(button, menu) {
    if (!button || !menu) return null;
    const items = () => [...menu.querySelectorAll('[role^="menuitem"]:not(:disabled):not([hidden])')];
    const api = {
      menu,
      open(focusFirst) {
        closeAll(api);
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        if (focusFirst) items()[0]?.focus();
      },
      close(refocus) {
        if (menu.hidden) return;
        menu.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        if (refocus) button.focus();
      },
    };
    menus.push(api);
    button.addEventListener('click', (e) => {
      e.preventDefault();
      if (menu.hidden) api.open(e.detail === 0); // a keyboard "click" (Enter, Space) lands on the first row; a pointer one doesn't move focus
      else api.close(false);
    });
    button.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); api.open(true); const list = items(); if (e.key === 'ArrowUp') list[list.length - 1]?.focus(); }
      else if (e.key === 'Escape' && !menu.hidden) { e.preventDefault(); e.stopPropagation(); api.close(true); }
    });
    menu.addEventListener('keydown', (e) => {
      const list = items();
      const at = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(true); }
      else if (e.key === 'Tab') api.close(false);
    });
    menu.addEventListener('click', (e) => { if (e.target.closest('[role^="menuitem"]')) api.close(false); }); // after the row's own handler has run
    return api;
  }

  setup(byId('composer-plus'), byId('composer-menu'));
  const more = setup(byId('send-more'), byId('send-menu'));
  document.addEventListener('pointerdown', (e) => { for (const m of menus) if (!m.menu.hidden && !m.menu.parentElement.contains(e.target)) m.close(false); });
  window.addEventListener('blur', () => closeAll());
  byId('send')?.addEventListener('contextmenu', (e) => { if (more && !byId('send-more').hidden) { e.preventDefault(); more.open(true); } }); // right-click on Send: the same menu

  // Mirror the rows' state.
  const watch = (el, attrs, fn) => { if (!el) return; fn(); new MutationObserver(fn).observe(el, { attributes: true, attributeFilter: attrs }); };
  const screenBtn = byId('screen-btn');
  watch(screenBtn, ['data-state'], () => {
    const state = screenBtn.dataset.state;
    const lit = state === 'on' || state === 'auto';
    screenBtn.setAttribute('aria-checked', String(lit));
    const dot = byId('plus-dot');
    if (dot) dot.hidden = !lit;
    const label = byId('screen-state');
    if (label) label.textContent = state === 'on' ? tr('sidebar.state.on', 'On') : state === 'auto' ? tr('composer.menu.auto', 'Auto') : state === 'off' ? tr('sidebar.state.off', 'Off') : '';
    const plusBtn = byId('composer-plus');
    if (plusBtn) plusBtn.dataset.lit = lit ? '1' : '';
  });
  const sendBg = byId('send-bg');
  watch(sendBg, ['hidden'], () => { // background tasks turned off: no chevron, no empty menu
    const chevron = byId('send-more');
    if (chevron) chevron.hidden = sendBg.hidden;
    if (sendBg.hidden) more?.close(false);
  });
})();
