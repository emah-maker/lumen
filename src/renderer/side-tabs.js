// Tab layout: Side (Settings → Tabs and browsing). The tabs listed down the left of the window instead of across the top.
// It is the same list: #tabs, drawn by app.js (favicon, title, ✕, speaker, pins, groups, menus, keyboard), is moved into the column
// and laid out as rows (side-tabs.css). The page area is the rest of the row, so where the page goes follows by itself (app.js reports it).
// What is new here: moving the list in and out, the width (dragging the edge), icons-only with a peek on hover, the right-click menu,
// and the drag, which is up and down (app.js's own is along the strip). Loaded after app.js; the pure parts are in side-tabs-core.js.
{
  const core = window.sideTabsCore;
  const panel = $('side-tabs');
  const list = $('side-tabs-list');
  const head = $('side-head');
  const tabsEl = $('tabs');
  const strip = $('tabstrip');
  const newTab = $('new-tab');
  const collapseBtn = $('side-collapse');
  const grip = $('side-resize');
  const TEAR_PX = 48; // a tab dragged this far past the list (or out of the window) leaves for a window of its own
  let cfg = core.fromPrefs(null);
  let peekTimer = 0;
  let leaveTimer = 0;
  let saveTimer = 0;

  const save = (o) => { try { Promise.resolve(window.browser.sideTabs?.(o)).catch(() => {}); } catch { /* an older main */ } };

  // ---- placing the list
  function place() {
    document.body.classList.toggle('side-layout', cfg.on);
    panel.hidden = !cfg.on;
    tabsEl.classList.toggle('side', cfg.on);
    tabsEl.setAttribute('aria-orientation', cfg.on ? 'vertical' : 'horizontal');
    if (cfg.on) {
      list.append(tabsEl);
      head.prepend(newTab);
    } else {
      strip.insertBefore(tabsEl, strip.firstChild);
      strip.insertBefore(newTab, tabsEl.nextSibling);
    }
    hideHoverCard();
    // Drawn again where it is now, with no slide of every tab across the window.
    tabsRendered = false;
    lastLayoutSig = null;
    if (lastTabState) renderTabsNow(lastTabState);
  }
  function paint() {
    panel.style.setProperty('--side-w', `${cfg.width}px`);
    panel.classList.toggle('collapsed', cfg.collapsed);
    if (!cfg.collapsed) panel.classList.remove('peek');
    const label = t(cfg.collapsed ? 'tabs.side.expand' : 'tabs.side.collapse');
    collapseBtn.title = label;
    collapseBtn.setAttribute('aria-label', label);
    collapseBtn.setAttribute('aria-pressed', String(cfg.collapsed));
  }
  function apply(p) {
    const was = cfg.on;
    cfg = core.fromPrefs(p);
    paint();
    if (cfg.on !== was) place();
    if (cfg.on && typeof sidebarWish === 'number') setSidebarWidth(sidebarWish); // (the AI sidebar keeps the page its room)
  }
  const fromPrefs = () => { const p = window.lumenSideTabs; if (p) apply(p); };
  document.addEventListener('lumen:side-tabs', fromPrefs);
  fromPrefs();

  collapseBtn.addEventListener('click', () => save({ collapsed: !cfg.collapsed }));

  // ---- icons only: it opens out while the pointer is over it (the page makes room: the list is not drawn over it, the page is a layer above)
  panel.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'touch') return;
    clearTimeout(leaveTimer);
    if (!cfg.collapsed || panel.classList.contains('peek')) return;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => panel.classList.add('peek'), 180);
  });
  panel.addEventListener('pointerleave', () => {
    clearTimeout(peekTimer);
    if (drag || !panel.classList.contains('peek')) return;
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => { if (!drag && !panel.matches(':focus-within')) panel.classList.remove('peek'); }, 250);
  });
  panel.addEventListener('focusin', (e) => { if (cfg.collapsed && e.target.matches?.(':focus-visible')) { clearTimeout(leaveTimer); panel.classList.add('peek'); } });
  panel.addEventListener('focusout', (e) => { if (!panel.contains(e.relatedTarget) && !panel.matches(':hover')) panel.classList.remove('peek'); });

  // ---- width: drag the right edge (kept), arrow keys on it, double-click for the default
  const setWidth = (w) => { cfg.width = core.clampWidth(w); panel.style.setProperty('--side-w', `${cfg.width}px`); };
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = cfg.width;
    document.body.classList.add('side-resizing');
    const move = (ev) => setWidth(w0 + ev.clientX - x0);
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      document.body.classList.remove('side-resizing');
      save({ width: cfg.width });
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => { setWidth(core.DEFAULT); save({ width: cfg.width }); });
  grip.addEventListener('keydown', (e) => {
    const to = { ArrowLeft: cfg.width - 16, ArrowRight: cfg.width + 16, Home: core.MIN, End: core.MAX }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setWidth(to);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save({ width: cfg.width }), 300);
  });

  // ---- right-click on the empty part of the strip or the list: the layout menu (main.js tabs:strip-menu)
  const menuAt = (e) => {
    if (e.defaultPrevented || e.target.closest?.('.tab, .group-label')) return;
    e.preventDefault();
    window.browser.stripMenu?.({ x: e.clientX, y: e.clientY });
  };
  for (const el of [panel, tabsEl, newTab]) el.addEventListener('contextmenu', menuAt);

  // ---- dragging (app.js calls these while `drag` is a drag that began in the side list)
  const inWindow = (e) => e.clientX >= -TEAR_PX / 2 && e.clientY >= -TEAR_PX / 2 && e.clientX <= window.innerWidth + TEAR_PX / 2 && e.clientY <= window.innerHeight + TEAR_PX / 2;
  const out = (e) => e.clientX > panel.getBoundingClientRect().right + TEAR_PX || !inWindow(e);
  const near = (e) => e.clientX > panel.getBoundingClientRect().right + 8 || e.clientX < 8 || e.clientY > window.innerHeight - 8;

  // What can take the dragged tab(s): the tabs and group labels on show, in order (a label stands for its group's first tab, as in app.js
  // stripTargets). Pinned tabs only among pinned ones.
  function candidates(d) {
    const skip = new Set(d.moving);
    const now = lastTabState?.tabs || [];
    const groups = lastTabState?.groups || [];
    const found = [];
    for (const el of tabsEl.querySelectorAll('.tab:not(.tab-ghost), .group-label')) {
      if (el.matches('.handed, .held, .gathered')) continue;
      let id;
      let outside = false;
      if (el.classList.contains('group-label')) {
        const g = Number(el.dataset.group);
        if (d.pinnedDrag || g === d.groupId) continue;
        id = now.find((x) => x.groupId === g && !skip.has(x.id))?.id;
        outside = true; // before the label: before the group, outside it
      } else {
        id = Number(el.dataset.id);
        if (el.classList.contains('pinned') !== d.pinnedDrag) continue;
        const g = now.find((x) => x.id === id)?.groupId;
        if (g && groups.find((x) => x.id === g)?.collapsed) continue; // the one tab a folded group shows is part of the fold
      }
      if (id != null) found.push({ id, outside, r: el.getBoundingClientRect() });
    }
    return found;
  }

  function showLine(d, items, hit) {
    const line = d.line || (d.line = Object.assign(document.createElement('div'), { className: 'side-drop-line' }));
    if (!line.isConnected) document.body.append(line);
    const lr = list.getBoundingClientRect();
    const ref = hit || items[items.length - 1];
    if (!ref) { line.hidden = true; return; }
    line.hidden = false;
    const r = ref.r;
    const tile = d.pinnedDrag && r.right - r.left < lr.width / 2; // pinned tiles share a row: the line is upright
    const after = !hit;
    const box = tile
      ? { left: (after ? r.right + 1 : r.left - 1) - 1, top: r.top, width: 2, height: r.bottom - r.top }
      : { left: lr.left + 6, top: (after ? r.bottom + 1 : r.top - 1) - 1, width: lr.width - 12, height: 2 };
    Object.assign(line.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    const join = d.groupId == null && !d.pinnedDrag ? core.joinGroup(hit, lastTabState?.tabs || []) : null;
    const color = join && (lastTabState?.groups || []).find((x) => x.id === join)?.color;
    line.style.background = color ? `var(--g-${String(color).replace(/[^a-z]/g, '')})` : '';
  }

  function follow(d) {
    d.el.style.transform = `translate(${d.lastX - d.startX}px, ${d.lastY - d.startY + (list.scrollTop - d.scroll0)}px)`;
    const all = candidates(d);
    const skip = new Set(d.moving);
    const items = all.filter((it) => !skip.has(it.id));
    let hit = core.dropBefore(items, d.lastX, d.lastY, list.clientWidth);
    if (d.groupId != null) { // a group never lands inside another group: after it
      const tabsNow = lastTabState?.tabs || [];
      const inside = (it) => it && !it.outside && tabsNow.find((x) => x.id === it.id)?.groupId;
      const g = inside(hit);
      if (g) hit = items.slice(items.indexOf(hit) + 1).find((it) => inside(it) !== g) || null;
    }
    d.hit = hit;
    d.targeted = true;
    showLine(d, items, hit);
  }

  function stopEdge(d) { d.edge = 0; if (d.edgeTimer) { cancelAnimationFrame(d.edgeTimer); d.edgeTimer = 0; } }

  // The pointer went out: the tab (or group) goes to main, which makes it a window of its own or drops it in another window's strip.
  function handOff(e) {
    const d = drag;
    stopEdge(d);
    d.line?.remove();
    if (d.groupId == null) { handOffTabDrag(e); return; }
    d.handed = true;
    d.group = d.members;
    d.single = (lastTabState?.tabs.length || 0) - d.members.length < 1;
    d.el.style.transform = '';
    d.el.classList.remove('tearing');
    if (d.single) {
      d.el.classList.remove('dragging');
      tabsEl.classList.remove('reordering');
    } else {
      d.el.classList.add('handed');
      for (const el of tabsEl.querySelectorAll('.tab')) if (d.members.includes(Number(el.dataset.id))) el.classList.add('handed');
    }
    window.browser.dragTabStart(d.id, { x: e.clientX, y: e.clientY, stripX: d.into + 12, pressY: api.tearY(d.el), ids: d.members, group: d.groupId, layout: null });
  }

  const api = {
    // The pointer moved with a drag held.
    move(e) {
      const d = drag;
      if (!d.moved && Math.abs(e.clientX - d.startX) < 5 && Math.abs(e.clientY - d.startY) < 5) return;
      if (!d.moved) {
        d.moved = true;
        hideHoverCard();
        d.el.classList.add('dragging');
        tabsEl.classList.add('reordering');
        d.scroll0 = list.scrollTop;
        const label = d.groupId != null;
        d.moving = label ? d.members : selectedTabs.size > 1 && selectedTabs.has(d.id) ? stripOrder().filter((x) => selectedTabs.has(x)) : [d.id];
        d.pinnedDrag = !label && d.el.classList.contains('pinned');
        // Every tab of the window is moving: the window itself follows the pointer right away, like its title bar.
        if (window.browser.dragTabStart && (lastTabState?.tabs.length || 0) - d.moving.length < 1) { handOff(e); return; }
      }
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      if (!d.prepped && window.browser.dragTabPrep && near(e)) { d.prepped = true; window.browser.dragTabPrep(d.id); }
      if (window.browser.dragTabStart && out(e)) { handOff(e); return; }
      follow(d);
      // Held near the top or bottom of a list that scrolls, it keeps scrolling.
      const lr = list.getBoundingClientRect();
      d.edge = list.scrollHeight > list.clientHeight + 1 ? (e.clientY < lr.top + 28 ? -1 : e.clientY > lr.bottom - 28 ? 1 : 0) : 0;
      if (d.edge && !d.edgeTimer) {
        const tick = () => {
          if (drag !== d || !d.edge || d.handed) { d.edgeTimer = 0; return; }
          list.scrollTop += 9 * d.edge;
          follow(d);
          d.edgeTimer = requestAnimationFrame(tick);
        };
        d.edgeTimer = requestAnimationFrame(tick);
      }
    },
    // The drag ended (app.js endTabDrag, before it tidies up): drop it where the line was.
    end(d, escaped) {
      stopEdge(d);
      d.line?.remove();
      if (d.handed) return; // main drives it from here
      d.el.style.transform = '';
      d.el.classList.remove('dragging', 'tearing');
      tabsEl.classList.remove('reordering');
      if (!d.moved || escaped || !d.targeted) return;
      const hit = d.hit;
      const home = core.homeBefore(candidates(d), d.moving);
      if ((hit?.id ?? null) === (home?.id ?? null)) return; // let go where it started: nothing moves
      const tabsNow = lastTabState?.tabs || [];
      const live = $('tab-live');
      expectMove(); // (the list holds updates until main has put the tabs in order)
      if (d.groupId != null) window.browser.moveTabs?.(d.members, hit?.id ?? null, d.groupId);
      else if (d.pinnedDrag) window.browser.moveTab?.(d.id, indexBefore(hit?.id ?? null, d.id), true);
      else window.browser.moveTabs?.(d.moving, hit?.id ?? null, null, core.joinGroup(hit, tabsNow));
      if (live) live.textContent = d.moving.length > 1 ? t('tabs.movedMany', { n: d.moving.length }) : t('tabs.moved', { title: tabsNow.find((x) => x.id === d.id)?.title || '' });
    },
    // Where the grabbed tab sits in the new window's list, from the top of the window.
    tearY(el) { return Math.round(list.getBoundingClientRect().top + 6 + (el.offsetHeight || 30) / 2); },
  };
  window.sideTabs = api;
}
