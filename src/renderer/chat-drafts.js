// Each chat's unsent draft (what is typed in the composer and the long pasted blocks waiting as chips), kept on this machine so it
// comes back when the chat is opened again, also after a restart. One localStorage entry holds every draft, keyed by the chat id
// ('new' is the chat not started yet); the oldest go past MAX_DRAFTS. Plain script in the UI (chat-core.js uses it);
// test/chat-drafts-units.js loads it with require().
(function (root) {
  const KEY = 'lumen.chatDrafts';
  const MAX_DRAFTS = 100;
  const MAX_CHARS = 400000; // one draft (text and pasted blocks together); a draft bigger than this is not kept
  const LONG_PASTE = 2000; // a pasted block longer than this is offered as a chip

  const keyOf = (id) => (id ? String(id) : 'new');
  const emptyDraft = (d) => !d || (!String(d.text || '').trim() && !(d.pastes || []).length);

  // `key`: the localStorage entry. The sidebar and the full-page chat share one origin's storage, so each keeps its own entry (chat-core.js): one
  // surface saving its composer (it does so whenever the chat it shows changes) must never overwrite what the other has typed.
  function create(storage, now = Date.now, key = KEY) {
    const load = () => {
      try {
        const parsed = JSON.parse(storage.getItem(key) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch { return {}; }
    };
    const save = (all) => {
      const keys = Object.keys(all);
      if (keys.length > MAX_DRAFTS) for (const k of keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, keys.length - MAX_DRAFTS)) delete all[k];
      try { if (Object.keys(all).length) storage.setItem(key, JSON.stringify(all)); else storage.removeItem(key); } catch {}
    };
    return {
      // -> { text, pastes: [string] } or null
      get(id) {
        const d = load()[keyOf(id)];
        if (!d || emptyDraft(d)) return null;
        return { text: String(d.text || ''), pastes: (Array.isArray(d.pastes) ? d.pastes : []).filter((p) => typeof p === 'string' && p) };
      },
      set(id, draft) {
        const all = load();
        const k = keyOf(id);
        const text = String(draft?.text || '');
        const pastes = (draft?.pastes || []).filter((p) => typeof p === 'string' && p);
        if (emptyDraft({ text, pastes }) || text.length + pastes.reduce((n, p) => n + p.length, 0) > MAX_CHARS) delete all[k];
        else all[k] = { text, pastes, at: now() };
        save(all);
      },
      clear(id) { this.set(id, null); },
      // A chat that was just named takes the draft of the chat not started yet.
      rename(fromId, toId) {
        const d = this.get(fromId);
        if (!d) return;
        this.clear(fromId);
        this.set(toId, d);
      },
    };
  }

  const isLongPaste = (text) => String(text || '').length > LONG_PASTE;
  // The message as it is sent: what was typed, then each pasted block in a code fence (longer than any run of backticks inside it).
  function withPastes(text, blocks) {
    const out = [String(text || '').trim()].filter(Boolean);
    for (const block of blocks || []) {
      const longest = Math.max(2, ...(String(block).match(/`+/g) || []).map((m) => m.length));
      const fence = '`'.repeat(longest + 1);
      out.push(`${fence}\n${String(block).replace(/\s+$/, '')}\n${fence}`);
    }
    return out.join('\n\n');
  }

  const api = { create, isLongPaste, withPastes, LONG_PASTE, KEY, MAX_DRAFTS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.chatDrafts = api;
})(this);
