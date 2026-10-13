// lumen://chat: drag chats into projects, and pick several chats to move together.
//   const drag = window.chatProjectDrag.create({ items, host, chats(), projects(), inProjectView(), isExpanded(id), expand(id),
//                                               announce(text), move(ids, projectId|null), onEnd() })
//     items      the history list (#cp-items)          host   the rail's Projects block (#cp-projects)
//     chats()    the chats as last listed ({ id, title, project? })   projects()   [{ id, name }]
//     inProjectView()  the list shows one project's chats: dropping on the list then means nothing (use "Remove from project")
//     isExpanded / expand   a collapsed project opens after the pointer rests on it while dragging
//     move(ids, projectId)  called on a drop that changes something (null: out of any project)
//     onEnd()    the drag ended (the page draws what it held back meanwhile)
//   drag.active(), drag.refresh() (after the rail was drawn again), drag.selection: { ids(), has(id), clear(), paint(), prune() }
//
// Pointer events, not HTML5 drag and drop: one code path for the mouse and a pen, a ghost we draw ourselves, and the rows keep working
// as buttons. Touch is left to the row menu's "Move to project", as is the keyboard. Selecting: Ctrl+click (Cmd+click on a Mac) toggles
// a row, Shift+click selects the rows between; a plain click clears the selection and opens as usual; Escape clears it.
(() => {
  const tr = (key, english) => (window.chatTr ? window.chatTr(key, english) : english);
  const MOVE_PX = 5; // the pointer must travel this far before a press becomes a drag (a click stays a click)
  const HOVER_EXPAND_MS = 600;
  const ROW = '.chat-item[data-id], .cp-pj-chat[data-id]';
  const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const isMac = () => document.documentElement.classList.contains('platform-darwin');
  const multiKey = (e) => (isMac() ? e.metaKey : e.ctrlKey);

  function create({ items, host, chats, projects, inProjectView = () => false, isExpanded, expand, announce = () => {}, move, onEnd = () => {} }) {
    const byId = (id) => chats().find((c) => c.id === id) || null;
    const projectOf = (id) => byId(id)?.project || null;

    // ---- selection
    const picked = new Set();
    let anchor = null;
    const order = () => [...items.querySelectorAll('.chat-item[data-id]')].map((r) => r.dataset.id);
    const say = () => { if (picked.size) announce(tr('chatpage.drag.selected', '{n} chats selected. Drag them onto a project, or use a chat’s menu.').replace('{n}', picked.size)); };
    const selection = {
      ids: () => { const live = chats().map((c) => c.id).filter((id) => picked.has(id)); return live; },
      has: (id) => picked.has(id),
      get size() { return picked.size; },
      clear() { if (!picked.size) return; picked.clear(); anchor = null; selection.paint(); },
      paint() { for (const r of items.querySelectorAll('.chat-item[data-id]')) r.classList.toggle('selected', picked.has(r.dataset.id)); items.classList.toggle('has-selection', picked.size > 0); },
      prune() { const have = new Set(chats().map((c) => c.id)); for (const id of [...picked]) if (!have.has(id)) picked.delete(id); if (!picked.size) anchor = null; },
    };
    // Capture phase: a Ctrl/Shift click is a selection, and must not also open the chat (chat-items.js's own click handler).
    items.addEventListener('click', (e) => {
      const row = e.target.closest?.('.chat-item[data-id]');
      if (!row || !e.target.closest('.chat-open')) return;
      const id = row.dataset.id;
      if (multiKey(e)) {
        e.preventDefault(); e.stopPropagation();
        if (picked.has(id)) picked.delete(id); else picked.add(id);
        anchor = id;
      } else if (e.shiftKey) {
        e.preventDefault(); e.stopPropagation();
        const ids = order();
        const from = ids.indexOf(anchor && ids.includes(anchor) ? anchor : [...picked].find((p) => ids.includes(p)) ?? id);
        const to = ids.indexOf(id);
        for (const x of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) picked.add(x);
        if (!anchor) anchor = id;
      } else { if (picked.size) selection.clear(); return; }
      selection.paint();
      say();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (state) { e.preventDefault(); e.stopPropagation(); cancel(); return; }
      if (picked.size && !document.querySelector('.cp-pj-pick, .cp-pj-dialog, .chat-item.menu-open') && !e.target.closest?.('input, textarea')) { e.preventDefault(); selection.clear(); }
    }, true);

    // ---- the drag
    let down = null; // a press on a row that may become a drag
    let state = null; // { ids, ghost, target, expandTimer, expandFor, none }
    let releasedAt = 0; // when a drag was released: the click that follows it is not a click on the row under the pointer
    const folded = new Set();

    const targetAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const pj = el.closest('.cp-pj-item[data-project], .cp-pj-chats[data-project]');
      if (pj) return { kind: 'project', id: pj.dataset.project };
      if (el.closest('.cp-pj-none')) return { kind: 'none' };
      if (!inProjectView() && (items.contains(el) || el === items)) return { kind: 'none' };
      return null;
    };
    const validFor = (ids, target) => (target.kind === 'project' ? ids.some((id) => projectOf(id) !== target.id) : ids.some((id) => projectOf(id)));

    function paint() {
      if (!state) return;
      const { ids, target } = state;
      document.body.classList.add('cp-dragging');
      for (const r of document.querySelectorAll(ROW)) r.classList.toggle('dragging', ids.includes(r.dataset.id));
      for (const n of host.querySelectorAll('.cp-pj-item, .cp-pj-chats')) {
        const id = n.dataset.project;
        const here = target?.kind === 'project' && target.id === id;
        const ok = validFor(ids, { kind: 'project', id });
        n.classList.toggle('drop-ok', ok && !here);
        n.classList.toggle('drop-over', here && ok);
        n.classList.toggle('drop-same', here && !ok);
      }
      const noneOk = state.none && validFor(ids, { kind: 'none' });
      const overNone = target?.kind === 'none' && noneOk;
      state.none?.classList.toggle('drop-over', overNone);
      items.classList.toggle('drop-none', Boolean(noneOk && !inProjectView()));
      items.classList.toggle('drop-over', Boolean(overNone && !inProjectView() && target && items.dataset.over === '1'));
    }
    const clearPaint = () => {
      document.body.classList.remove('cp-dragging');
      for (const r of document.querySelectorAll('.dragging')) r.classList.remove('dragging');
      for (const n of document.querySelectorAll('.drop-ok, .drop-over, .drop-same, .drop-none')) n.classList.remove('drop-ok', 'drop-over', 'drop-same', 'drop-none');
    };

    function start(e) {
      const ids = picked.has(down.id) ? selection.ids() : [down.id];
      if (!picked.has(down.id)) selection.clear();
      const ghost = Object.assign(document.createElement('div'), { className: 'cp-drag-ghost' });
      ghost.setAttribute('aria-hidden', 'true');
      ghost.append(Object.assign(document.createElement('span'), { className: 'cp-drag-title', textContent: byId(ids[0])?.title || tr('chats.untitled', 'Chat') }));
      if (ids.length > 1) ghost.append(Object.assign(document.createElement('span'), { className: 'cp-drag-count', textContent: String(ids.length) }));
      document.body.append(ghost);
      let none = null;
      if (ids.some((id) => projectOf(id))) {
        none = Object.assign(document.createElement('div'), { className: 'cp-pj-none', textContent: tr('chatpage.project.none', 'Remove from project') });
        host.append(none);
      }
      state = { ids, ghost, target: null, none, expandTimer: null, expandFor: null };
      place(e);
      paint();
    }
    function place(e) { if (state) state.ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`; }

    function hover(target) {
      const same = (a, b) => (a?.kind === b?.kind) && (a?.id === b?.id);
      if (same(state.target, target)) return;
      state.target = target;
      clearTimeout(state.expandTimer);
      state.expandFor = null;
      // A collapsed project the pointer rests on opens, so a chat can be dropped among its chats.
      if (target?.kind === 'project' && !isExpanded(target.id)) {
        state.expandFor = target.id;
        state.expandTimer = setTimeout(() => { if (state?.expandFor === target.id && state.target?.id === target.id) { expand(target.id); paint(); } }, HOVER_EXPAND_MS);
      }
    }

    function finish() {
      if (!state) return;
      clearTimeout(state.expandTimer);
      state.ghost.remove();
      state.none?.remove();
      clearPaint();
      state = null;
      down = null;
      releasedAt = performance.now();
      onEnd();
    }
    function cancel() { finish(); }

    document.addEventListener('pointerdown', (e) => {
      releasedAt = 0; // (a new press: whatever followed the last drag is over)
      if (e.button !== 0 || e.pointerType === 'touch' || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const open = e.target.closest?.('.chat-open, .cp-pj-chat');
      const row = open?.closest(ROW);
      if (!row || !(items.contains(row) || host.contains(row))) return;
      down = { id: row.dataset.id, x: e.clientX, y: e.clientY };
    }, true);
    document.addEventListener('pointermove', (e) => {
      if (!down) return;
      if (e.buttons === 0) { if (!state) down = null; else finish(); return; }
      if (!state) {
        if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < MOVE_PX) return;
        start(e);
      }
      e.preventDefault();
      place(e);
      const target = targetAt(e.clientX, e.clientY);
      items.dataset.over = target?.kind === 'none' && !e.target.closest?.('.cp-pj-none') ? '1' : '0';
      hover(target);
      paint();
    }, true);
    document.addEventListener('pointerup', (e) => {
      if (!down) return;
      if (!state) { down = null; return; }
      const { ids } = state;
      const target = targetAt(e.clientX, e.clientY);
      finish();
      if (target && validFor(ids, target)) move(ids, target.kind === 'project' ? target.id : null);
    }, true);
    document.addEventListener('pointercancel', () => { if (state) cancel(); else down = null; }, true);
    window.addEventListener('blur', () => { if (state) cancel(); });
    document.addEventListener('click', (e) => { if (releasedAt && performance.now() - releasedAt < 120 && e.target.closest?.(ROW + ', .cp-pj-item, .cp-pj-chats, .cp-pj-none')) { releasedAt = 0; e.preventDefault(); e.stopPropagation(); } }, true); // the release over a row is not a click on it
    document.addEventListener('selectstart', (e) => { if (state) e.preventDefault(); });

    void folded; void reducedMotion;
    return { active: () => Boolean(state), refresh: () => { if (state) { state.none = host.querySelector('.cp-pj-none') || state.none; if (state.none && !state.none.isConnected) host.append(state.none); paint(); } }, selection };
  }

  window.chatProjectDrag = { create };
})();
