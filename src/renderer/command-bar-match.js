// Ranking for the command bar (Ctrl+K, renderer/command-bar.js). Plain script in the UI; test/units/command-bar-units.js loads it with require().
// It reuses tab search's word matcher (tab-search-match.js): a whole-word start beats a substring, which beats letters in order.
//
// An item is { id, group, title, keywords?, url?, ... } and group is one of GROUPS. `search` returns the rows to draw, in order, each with
// its `group`: grouped under headings, the group with the best match first, and "Ask AI" as the last row whenever something is typed.
(function (root) {
  const base = typeof module === 'object' && module.exports ? require('./tab-search-match') : root.tabSearchMatch;

  const GROUPS = ['recent', 'action', 'tab', 'setting', 'bookmark', 'history']; // the order groups come in when their best scores tie
  const CAPS = { recent: 5, tab: 6, action: 7, setting: 5, bookmark: 5, history: 5 }; // rows shown per group while typing
  const EMPTY_CAPS = { recent: 5, tab: 8, action: 12 }; // and with nothing typed (nothing else is shown then)
  const BONUS = { action: 9, tab: 6, bookmark: 3, setting: 0, history: 0 }; // a command or a tab you can jump to beats the same match in a bookmark, which beats History

  const SCHEME = /^https?:\/\/(www\.)?/i;
  const norm = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[#?].*$/, '').replace(/\/$/, '');

  // How well one item matches the query (every word has to match), or -1. A word matches the title the way tab search matches it (a word
  // start, a piece, or the letters in order); in the keywords and the address only a piece of the text counts, and a little less, so a long
  // list of keywords is not matched by letters that happen to be in it. A title that has the whole query in it counts extra.
  function score(query, item) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return 0;
    const title = String(item.title || '').toLowerCase();
    const where = [item.keywords, String(item.url || '').replace(SCHEME, '')].filter(Boolean).join(' ').toLowerCase();
    let total = 0;
    for (const word of q.split(/s+/)) {
      const inTitle = base.wordScore(word, title) * 1.2;
      const w = base.wordScore(word, where);
      const best = Math.max(inTitle, w >= 40 ? w * 0.8 : -1);
      if (best < 0) return -1;
      total += best;
    }
    return total + (title.startsWith(q) ? 25 : 0) + (title.includes(q) ? 20 : 0) + (BONUS[item.group] || 0);
  }

  // The most recently run commands (ids, newest first) ahead of a tie, and a little ahead of a worse match.
  function recentBoost(recent, id) {
    const i = recent.indexOf(id);
    return i === -1 ? 0 : Math.max(2, 12 - i * 2);
  }

  // The rows for `query`. opts: { recent: [ids of commands run lately, newest first], askLabel }.
  function search(query, items, opts = {}) {
    const recent = Array.isArray(opts.recent) ? opts.recent : [];
    const q = String(query || '').trim();
    const list = Array.isArray(items) ? items : [];
    if (!q) {
      const byId = new Map(list.filter((i) => i.group === 'action' || i.group === 'setting').map((i) => [i.id, i]));
      const recents = recent.map((id) => byId.get(id)).filter(Boolean).slice(0, EMPTY_CAPS.recent).map((i) => ({ ...i, group: 'recent' }));
      const used = new Set(recents.map((r) => r.id));
      const tabs = list.filter((i) => i.group === 'tab').slice(0, EMPTY_CAPS.tab);
      const actions = list.filter((i) => i.group === 'action' && !used.has(i.id)).slice(0, EMPTY_CAPS.action);
      return [...recents, ...tabs, ...actions];
    }
    // A page that is already an open tab is not listed again as a bookmark, and one that is a tab or a bookmark is not listed again from History.
    const open = new Set(list.filter((i) => i.group === 'tab' && i.url).map((i) => norm(i.url)));
    const seen = new Set(open);
    for (const i of list) if (i.group === 'bookmark' && i.url && !open.has(norm(i.url))) seen.add(norm(i.url));
    const groups = new Map();
    list.forEach((item, order) => {
      if (item.group === 'history' && item.url && seen.has(norm(item.url))) return;
      if (item.group === 'bookmark' && item.url && open.has(norm(item.url))) return;
      const s = score(q, item);
      if (s < 0) return;
      const total = s + (item.group === 'action' || item.group === 'setting' ? recentBoost(recent, item.id) : 0);
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push({ item, total, order });
    });
    const ordered = [...groups.entries()].map(([group, rows]) => {
      rows.sort((a, b) => b.total - a.total || a.order - b.order);
      return { group, rows: rows.slice(0, CAPS[group] || 5), best: rows[0].total };
    }).sort((a, b) => b.best - a.best || GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
    const out = ordered.flatMap((g) => g.rows.map((r) => r.item));
    out.push({ id: 'ask', group: 'ask', title: q, text: q });
    return out;
  }

  const api = { GROUPS, score, search, norm };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.commandBarMatch = api;
})(this);
