// The pure parts of the toolbar's extension buttons (Settings → Extensions → Show extensions in the toolbar, and the puzzle button's menu):
// which extensions are pinned, in what order, and where each one shows. Like Chrome's puzzle menu, a pinned extension has its button in the
// toolbar and the others are listed in the menu. A plain script in the UI (renderer/extensions-bar.js uses it); the settings backend loads it
// with require() the first time a pin changes; test/units/ext-pins-units.js checks it.
(function (root) {
  const MODES = ['pinned', 'all', 'none']; // Only the ones I pin | All pinned | Hide all
  const DEFAULT_MODE = 'pinned';
  const AUTO_PIN = 3; // a newly seen extension starts pinned while fewer than this many are; after that it starts in the menu
  const MAX = 200;
  const ID = /^[a-p]{32}$/; // an extension id (Chrome's alphabet)

  const ids = (list) => [...new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === 'string' && ID.test(id)))].slice(0, MAX);
  const cleanMode = (m) => (MODES.includes(m) ? m : DEFAULT_MODE);
  // { order: the pinned ids, left to right; seen: every id that has had its first choice; migrated: the extensions that were installed before
  // pins existed have been pinned }. An id in `order` is always in `seen`.
  function clean(state) {
    const order = ids(state?.order);
    return { order, seen: [...new Set([...ids(state?.seen), ...order])].slice(-MAX), migrated: state?.migrated === true };
  }

  // The installed extensions that have a button (`installed`, in their current order) meet the state. Until the state is `migrated` (the first run
  // of the version that has pins) every one not seen is pinned, so nobody's toolbar changes on upgrade. After that, an extension not seen
  // before is pinned while there are fewer than AUTO_PIN pinned, and goes to the menu after. `done` (migrate only: the installed extensions
  // have all loaded) marks the state migrated. An id that is not installed (it may only still be loading) keeps its place.
  function reconcile(state, installed, done) {
    const s = clean(state);
    const order = [...s.order];
    const seen = new Set(s.seen);
    for (const id of ids(installed)) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!s.migrated || order.length < AUTO_PIN) order.push(id);
    }
    return clean({ order, seen: [...seen], migrated: s.migrated || done === true });
  }

  // Pin an extension (its button goes to the end of the toolbar's row) or unpin it. Either way it has had its choice.
  function setPinned(state, id, on) {
    const s = clean(state);
    if (!ID.test(String(id))) return s;
    const order = s.order.filter((x) => x !== id);
    if (on) order.push(id);
    return clean({ order, seen: [...s.seen, id], migrated: s.migrated });
  }

  // `id` moved to just before `beforeId` among the pinned ones (null or not pinned: to the end).
  function move(state, id, beforeId) {
    const s = clean(state);
    if (!s.order.includes(id)) return s;
    const order = s.order.filter((x) => x !== id);
    const at = order.indexOf(beforeId);
    order.splice(at < 0 ? order.length : at, 0, id);
    return { ...s, order };
  }

  // One step left (-1) or right (1) in the pinned row: the keyboard's way to reorder.
  function nudge(state, id, step) {
    const s = clean(state);
    const i = s.order.indexOf(id);
    const j = i + (step < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= s.order.length) return s;
    const order = [...s.order];
    [order[i], order[j]] = [order[j], order[i]];
    return { ...s, order };
  }

  // Where each installed extension's button shows. `installed`: the ids that have a button. toolbar: the ids shown there, in order (pinned
  // ones first, in their order); menu: the ones only the puzzle button's menu lists; puzzle: 'always' | 'overflow' (only when the toolbar
  // has no room for every icon) | 'never'.
  function layout(state, mode, installed) {
    const have = ids(installed);
    const s = clean(state);
    const pinned = s.order.filter((id) => have.includes(id));
    const rest = have.filter((id) => !pinned.includes(id));
    const m = cleanMode(mode);
    if (!have.length || m === 'none') return { toolbar: [], menu: have, puzzle: 'never', mode: m };
    if (m === 'all') return { toolbar: [...pinned, ...rest], menu: [], puzzle: 'overflow', mode: m };
    return { toolbar: pinned, menu: rest, puzzle: 'always', mode: m };
  }

  // The puzzle button's dot: an extension that is not in the toolbar has something to say (a badge).
  const needsAttention = (lay, badged) => lay.puzzle !== 'never' && lay.menu.some((id) => badged.includes(id));

  const api = { MODES, DEFAULT_MODE, AUTO_PIN, ID, clean, cleanMode, reconcile, setPinned, move, nudge, layout, needsAttention };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.extPinsCore = api;
})(this);
