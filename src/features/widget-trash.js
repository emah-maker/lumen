// Removed widgets, held in memory for a little while so the new-tab page's Undo can bring one back
// with its settings (and its token: the caller passes it in and takes it out again). Nothing here is
// ever written to disk or sent to the page. Pure, with an injectable clock for tests.
'use strict';

// hold(entry) -> the entry is kept for `ttl` ms; take(id) -> it, or null when it has expired or was never held.
// entry: { id, widget, secretName?, secret? }
function createTrash({ now = Date.now, ttl = 30000, max = 5 } = {}) {
  const held = []; // oldest first
  const prune = () => {
    const t = now();
    for (let i = held.length - 1; i >= 0; i--) if (t - held[i].at > ttl) held.splice(i, 1);
    while (held.length > max) held.shift();
  };
  return {
    hold(entry) {
      if (!entry || typeof entry.id !== 'string') return false;
      prune();
      const i = held.findIndex((h) => h.entry.id === entry.id);
      if (i >= 0) held.splice(i, 1);
      held.push({ entry, at: now() });
      prune();
      return true;
    },
    take(id) {
      prune();
      const i = held.findIndex((h) => h.entry.id === id);
      return i < 0 ? null : held.splice(i, 1)[0].entry;
    },
    has(id) { prune(); return held.some((h) => h.entry.id === id); },
    clear() { held.length = 0; },
    get size() { prune(); return held.length; },
  };
}

module.exports = { createTrash };
