// The tab strip's multi-selection rules (Chrome's), as pure functions for clickTab in app.js. A plain script in
// the UI; test/units.js loads it with require().
// Shift+click selects the run from the anchor (else the active tab) to the clicked tab; Ctrl/Cmd+click toggles
// one (the last selected tab stays selected); a plain click ends the selection.
(function (root) {
  // The run of tab ids from the anchor to the clicked tab, or null when either isn't in the strip.
  function selectRange(order, anchorId, activeId, clickedId) {
    const anchor = order.includes(anchorId) ? anchorId : activeId;
    const a = order.indexOf(anchor);
    const b = order.indexOf(clickedId);
    if (a === -1 || b === -1) return null;
    return { anchor, ids: order.slice(Math.min(a, b), Math.max(a, b) + 1) };
  }

  // What a click on tab `id` does: { selection, anchor, activate }. `activate` is the tab to switch to (null:
  // stay on the active one); `selection` is the new set (empty: no multi-selection).
  function selectionAfterClick({ order, selected, anchorId, activeId, id, shift = false, toggle = false }) {
    if (shift) {
      const r = selectRange(order, anchorId, activeId, id);
      return r ? { selection: r.ids, anchor: r.anchor, activate: id } : { selection: [...selected], anchor: anchorId, activate: id };
    }
    if (toggle) {
      const current = new Set(selected.length ? selected : [activeId]);
      if (current.has(id)) {
        if (current.size === 1) return { selection: [...selected], anchor: anchorId, activate: null }; // the last one stays
        current.delete(id);
        if (id !== activeId) return { selection: [...current], anchor: anchorId, activate: null };
        // Taking the active tab out: the next selected tab along (else the one before) takes over.
        const i = order.indexOf(id);
        const next = order.slice(i + 1).find((x) => current.has(x)) ?? order.slice(0, i).reverse().find((x) => current.has(x)) ?? id;
        return { selection: [...current], anchor: next, activate: next };
      }
      current.add(id);
      return { selection: [...current], anchor: id, activate: id };
    }
    return { selection: [], anchor: id, activate: id };
  }

  const api = { selectRange, selectionAfterClick };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.tabSelection = api;
})(typeof window !== 'undefined' ? window : globalThis);
