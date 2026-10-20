// The toolbar's extension buttons, as Chrome's puzzle menu has them (needs ext-pins-core.js and the preload's <browser-action-list>).
// Settings → Extensions chooses what shows: only the extensions pinned (the default), all of them, or none. A pinned extension has its
// button in the toolbar, in the order the user dragged (or moved with Alt+Left / Alt+Right); the others are listed in the menu under the
// puzzle button, and a pick there runs the extension's action, its popup anchored to the puzzle button. A small dot on the puzzle button
// says an extension that is not in the toolbar has a badge to show. The list is a custom element with an open shadow root of one button
// per action; its buttons are hidden and ordered here, never removed, so they keep running and keep their badges.
{
  const core = window.extPinsCore;
  const list = document.getElementById('extension-actions');
  const puzzle = document.getElementById('actions-overflow');
  if (core && list && puzzle) {
    let mode = core.DEFAULT_MODE;
    let pins = core.clean(null);
    let lay = core.layout(pins, mode, []);
    let shown = false; // the first prefs have arrived (until then every button stays hidden: no flash of all of them)
    const nodes = () => [...(list.shadowRoot?.querySelectorAll('.action') || [])];
    const byId = (id) => nodes().find((n) => n.id === id);
    const label = puzzle.getAttribute('aria-label') || '';

    const clipped = () => {
      const lr = list.getBoundingClientRect();
      return nodes().some((n) => !n.hidden && n.getBoundingClientRect().right > lr.right + 1);
    };
    const set = (n, prop, v) => { if (n[prop] !== v) n[prop] = v; };

    let styled = false;
    const style = () => {
      if (styled || !list.shadowRoot) return;
      styled = true;
      const s = document.createElement('style');
      s.textContent = '.action:focus-visible { box-shadow: var(--focus-ring); } .action.dragging { opacity: 0.4; } .action.drop-before { box-shadow: -2px 0 0 var(--accent); } .action.drop-after { box-shadow: 2px 0 0 var(--accent); }';
      list.shadowRoot.appendChild(s);
    };

    let syncedFor = '';
    function apply() {
      style();
      const all = nodes();
      const ids = all.map((n) => n.id);
      const eff = core.reconcile(pins, ids); // what the first look will be (the same answer the settings backend saves)
      lay = core.layout(eff, mode, ids);
      const inBar = new Set(shown ? lay.toolbar : []);
      for (const n of all) {
        const at = lay.toolbar.indexOf(n.id);
        set(n, 'hidden', !inBar.has(n.id));
        if (at >= 0) set(n.style, 'order', String(at));
        set(n, 'draggable', mode !== 'none' && eff.order.includes(n.id));
      }
      document.documentElement.classList.toggle('pref-no-extensions', shown && mode === 'none');
      const badged = all.filter((n) => n.querySelector('.badge')).map((n) => n.id);
      const attention = shown && core.needsAttention(lay, badged);
      puzzle.classList.toggle('has-attention', attention);
      const text = attention ? window.t('toolbar.extensionsAttention') : label;
      if (puzzle.getAttribute('aria-label') !== text) { puzzle.setAttribute('aria-label', text); puzzle.title = text; }
      puzzle.hidden = !shown || lay.puzzle === 'never' || (lay.puzzle === 'overflow' && !clipped());
      // A button the saved pins have not met yet: the backend gives it its first choice (pinned while fewer than three are).
      const key = ids.join(',');
      if (shown && ids.some((id) => !pins.seen.includes(id)) && key !== syncedFor) { syncedFor = key; window.lumenPrefs?.syncExtensionPins?.(); }
    }
    let frame = 0;
    const refresh = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; apply(); }); };

    new ResizeObserver(refresh).observe(list);
    customElements.whenDefined('browser-action-list').then(() => {
      // subtree + attributes: a button's own size or badge can change (badge, popup state) without a child being added
      if (list.shadowRoot) new MutationObserver(refresh).observe(list.shadowRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'title'] });
      refresh();
    });
    const onPrefs = (p) => {
      if (!p || !('extensionsToolbar' in p)) return;
      mode = core.cleanMode(p.extensionsToolbar);
      pins = core.clean(p.extensionPins);
      shown = true;
      refresh();
    };
    window.lumenPrefs?.get().then(onPrefs).catch(() => {});
    window.lumenPrefs?.onChange(onPrefs);

    // The menu: every extension with a button, the toolbar's first (the main process adds the pin checkboxes and "Manage extensions").
    puzzle.onclick = () => {
      const r = puzzle.getBoundingClientRect();
      const items = [...lay.toolbar, ...lay.menu].map((id) => ({ id, title: byId(id)?.title || '' }));
      window.browser.openActionsOverflow?.({ x: Math.round(r.left), y: Math.round(r.bottom) }, items);
    };
    window.browser.onActionsOverflowPick?.((id) => {
      const r = puzzle.getBoundingClientRect();
      window.browserAction?.activate(list.partition || '_self', { eventType: 'click', extensionId: id, tabId: byId(id)?.tab ?? list.tab ?? -1, alignment: list.alignment, anchorRect: { x: r.left, y: r.top, width: r.width, height: r.height } });
    });

    // Order. Dragging a pinned button moves it before the one the pointer is left of; Alt+Left / Alt+Right moves the focused one a step.
    const save = (next) => {
      pins = next;
      apply();
      window.lumenPrefs?.setExtensionOrder?.(next.order);
    };
    const target = (e) => e.composedPath().find((n) => n instanceof Element && n.classList?.contains('action'));
    let dragging = null;
    const pinned = () => nodes().filter((n) => !n.hidden && n.draggable).sort((a, b) => Number(a.style.order) - Number(b.style.order));
    const clear = () => nodes().forEach((n) => n.classList.remove('dragging', 'drop-before', 'drop-after'));
    const dropAt = (x) => {
      const row = pinned().filter((n) => n.id !== dragging);
      const before = row.find((n) => { const r = n.getBoundingClientRect(); return x < r.left + r.width / 2; });
      return { before: before || null, last: row[row.length - 1] || null };
    };
    list.addEventListener('dragstart', (e) => {
      const n = target(e);
      if (!n?.draggable) return;
      dragging = n.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', n.title || n.id);
      n.classList.add('dragging');
    });
    list.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const { before, last } = dropAt(e.clientX);
      for (const n of nodes()) n.classList.remove('drop-before', 'drop-after');
      if (before) before.classList.add('drop-before'); else last?.classList.add('drop-after');
    });
    list.addEventListener('drop', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const id = dragging;
      const { before } = dropAt(e.clientX);
      dragging = null;
      clear();
      save(core.move(core.reconcile(pins, nodes().map((n) => n.id)), id, before?.id ?? null));
    });
    list.addEventListener('dragend', () => { dragging = null; clear(); });
    list.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      const n = target(e);
      if (!n?.draggable) return;
      e.preventDefault();
      const eff = core.reconcile(pins, nodes().map((x) => x.id));
      const next = core.nudge(eff, n.id, e.key === 'ArrowLeft' ? -1 : 1);
      if (next.order.join() !== eff.order.join()) save(next);
    });
  }
}
