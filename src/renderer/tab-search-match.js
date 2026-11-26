// Fuzzy matching for tab search (renderer/tab-search.js). Plain script in the UI; test/units/units.js
// loads it with require().
(function (root) {
  // How well `word` matches `text` (both lower case): a whole-word start beats a substring, which
  // beats letters in order with gaps ("gml" in "gmail"). -1 when it doesn't match at all.
  function wordScore(word, text) {
    if (!word) return 0;
    const at = text.indexOf(word);
    if (at !== -1) {
      const wordStart = at === 0 || /[^a-z0-9]/.test(text[at - 1]);
      return (wordStart ? 60 : 40) + Math.max(0, 20 - at / 4);
    }
    let score = 0;
    let run = 0;
    let from = 0;
    for (const ch of word) {
      const i = text.indexOf(ch, from);
      if (i === -1) return -1;
      run = i === from ? run + 1 : 1;
      score += run; // consecutive letters count for more
      from = i + 1;
    }
    return Math.min(30, score * (10 / Math.max(word.length, 1)));
  }

  // Score of one item ({ title, url, chat? }) for the whole query; every word has to match the title, the address or (a tab the AI
  // opened) the name of the chat that opened it. A title match counts a little more than an address match, a chat name a little less,
  // and in the chat name only a word or a piece of one counts (not letters scattered through it).
  function itemScore(query, item) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    const title = String(item.title || '').toLowerCase();
    const url = String(item.url || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
    const chat = String(item.chat || '').toLowerCase();
    let total = 0;
    for (const word of words) {
      const inChat = chat ? wordScore(word, chat) : -1;
      const best = Math.max(wordScore(word, title) * 1.2, wordScore(word, url), inChat >= 40 ? inChat * 0.9 : -1);
      if (best < 0) return -1;
      total += best;
    }
    return total;
  }

  // Items that match, best first; ties keep their original order. An empty query keeps them all.
  function rank(query, items) {
    if (!String(query || '').trim()) return items.slice();
    return items
      .map((item, i) => ({ item, i, score: itemScore(query, item) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((r) => r.item);
  }

  // [ai tab finder] "@ai" in the query keeps only the tabs the AI opened; the rest of it is searched as usual.
  const AI_WORD = /(^|\s)@ai(?=\s|$)/gi;
  function parseQuery(query) {
    const raw = String(query || '');
    const aiOnly = new RegExp(AI_WORD.source, 'i').test(raw);
    return { aiOnly, text: aiOnly ? raw.replace(AI_WORD, ' ').replace(/\s+/g, ' ').trim() : raw };
  }

  // Items in sections by the chat that opened them ({ chat } of each item; '' for none): [{ chat, items }], in the order each chat
  // first appears, its items in their own order.
  function byChat(items) {
    const sections = new Map();
    for (const item of items) {
      const key = item.chat || '';
      if (!sections.has(key)) sections.set(key, []);
      sections.get(key).push(item);
    }
    return [...sections.entries()].map(([chat, list]) => ({ chat, items: list }));
  }

  const api = { wordScore, itemScore, rank, parseQuery, byChat };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.tabSearchMatch = api;
})(this);
