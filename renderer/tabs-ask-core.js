// The logic behind "@" in the composer (renderer/tabs-ask.js): finding the mention being typed,
// filtering the tab picker, and the chips above the composer. No DOM. A plain script in the UI;
// test/units.js loads it with require().
(function (root) {
  const MAX_QUERY = 30;

  // The "@word" being typed at `caret`: the @ starts the text or follows a space, and nothing
  // between it and the caret is a line break or another @. Returns { start, end, query } or null.
  function mentionAt(text, caret) {
    const value = String(text || '');
    const end = Math.max(0, Math.min(caret ?? value.length, value.length));
    const at = value.lastIndexOf('@', end - 1);
    if (at === -1 || (at > 0 && !/\s/.test(value[at - 1]))) return null;
    const query = value.slice(at + 1, end);
    if (/[\n@]/.test(query) || query.length > MAX_QUERY) return null;
    return { start: at, end, query };
  }

  // The text with the mention taken out (it became a chip), and the caret where it was.
  function removeMention(text, mention) {
    const value = String(text || '');
    const before = value.slice(0, mention.start);
    return { text: before + value.slice(mention.end), caret: before.length };
  }

  const clean = (s) => String(s || '').toLowerCase();

  // Picker rows for `query`: "this tab" and "all tabs" first, then the tabs. Every word of the query
  // has to appear in a row's title or host. Tabs that already have a chip are left out.
  // tabs: [{ id, title, host, active, sleeping }]; chips: see addChip.
  function pickerItems(tabs, query, chips = []) {
    const words = clean(query).split(/\s+/).filter(Boolean);
    const has = (chip) => chips.some((c) => c.kind === chip.kind && c.id === chip.id);
    const rows = [];
    const special = [
      { kind: 'this', id: null, title: 'this tab', host: '' },
      { kind: 'all', id: null, title: 'all tabs', host: '', count: tabs.length },
    ];
    for (const s of special) {
      if (s.kind === 'this' && !tabs.some((t) => t.active)) continue;
      if (s.kind === 'all' && tabs.length < 2) continue;
      if (has(s)) continue;
      if (words.every((w) => s.title.includes(w) || (`@${s.title}`).includes(w))) rows.push(s);
    }
    const chipped = new Set(chips.filter((c) => c.kind === 'tab').map((c) => c.id));
    const allChip = chips.some((c) => c.kind === 'all');
    for (const t of tabs) {
      if (chipped.has(t.id) || allChip) continue;
      const hay = `${clean(t.title)} ${clean(t.host)}`;
      if (words.every((w) => hay.includes(w))) rows.push({ kind: 'tab', id: t.id, title: t.title, host: t.host, sleeping: Boolean(t.sleeping), active: Boolean(t.active) });
    }
    return rows;
  }

  // Chips are { kind: 'tab' | 'this' | 'all', id, title, host }. Adding "all tabs" replaces the
  // single-tab chips (it covers them); a tab that is already covered adds nothing.
  function addChip(chips, item) {
    if (chips.some((c) => c.kind === item.kind && c.id === item.id)) return chips;
    if (item.kind === 'all') return [{ kind: 'all', id: null, title: item.title, host: '' }];
    if (chips.some((c) => c.kind === 'all')) return chips;
    if (item.kind === 'this') return [...chips, { kind: 'this', id: null, title: item.title, host: '' }];
    return [...chips, { kind: 'tab', id: item.id, title: item.title, host: item.host }];
  }

  function removeChip(chips, index) {
    return chips.filter((_, i) => i !== index);
  }

  // The tab ids to send for the chips, from the tabs open right now. Tabs that closed since are
  // named in `gone`.
  function resolveChips(chips, tabs) {
    const ids = [];
    const gone = [];
    const push = (id) => { if (!ids.includes(id)) ids.push(id); };
    for (const c of chips) {
      if (c.kind === 'all') tabs.forEach((t) => push(t.id));
      else if (c.kind === 'this') { const t = tabs.find((x) => x.active); if (t) push(t.id); else gone.push(c.title); }
      else if (tabs.some((t) => t.id === c.id)) push(c.id);
      else gone.push(c.title);
    }
    return { ids, gone };
  }

  const api = { mentionAt, removeMention, pickerItems, addChip, removeChip, resolveChips, MAX_QUERY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.tabsAskCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
