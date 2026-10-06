// Per-tab address-bar drafts (Chrome's behaviour): text typed into the address bar and not submitted stays with
// its tab, so switching to another tab and back finds it (and the caret, and the focus) where it was left.
// Held in memory only: never saved, synced, or sent to main, the AI or extensions. A plain script in the UI
// (and the private window's UI); test/omnibox-draft-units.js loads it with require().
(function (root) {
  function createDraftStore() {
    const drafts = new Map(); // tab id -> { text, start, end, focused }
    return {
      // Remember what is in the field for `id`. Text equal to what the tab shows is no draft at all.
      save(id, field, shown) {
        if (id == null || !field) return false;
        const text = String(field.value ?? '');
        if (text === String(shown ?? '')) { drafts.delete(id); return false; }
        const len = text.length;
        const clamp = (n) => Math.min(len, Math.max(0, Number.isFinite(n) ? n : len));
        drafts.set(id, { text, start: clamp(field.start), end: clamp(field.end), focused: Boolean(field.focused) });
        return true;
      },
      get(id) { const d = drafts.get(id); return d ? { ...d } : null; },
      has(id) { return drafts.has(id); },
      clear(id) { drafts.delete(id); },
      // Drop the drafts of tabs that are gone.
      prune(ids) {
        const keep = new Set(ids);
        for (const id of [...drafts.keys()]) if (!keep.has(id)) drafts.delete(id);
      },
      get size() { return drafts.size; },
    };
  }

  const api = { createDraftStore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.omniboxDraft = api;
})(typeof window !== 'undefined' ? window : globalThis);
