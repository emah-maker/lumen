// Settings search: which settings a query finds, and how well. Plain functions (no DOM), shared by settings.js and the
// unit tests (test/units/settings-search-units.js).
//  - A query word matches where a word of the setting starts with it ("mode" finds "Dark mode", not "Model").
//  - A few everyday words also match what the setting calls it ("night" finds the dark theme, "adblock" the tracker blocker).
//  - A page's title ("AI and agents") only counts when the query is about that page (categoryHit), not every word in it, or "agents" would list every row on the page.
//  - Every query word must match; a hit in the label beats one in the group title, which beats one in the helper text.
(function () {
  // query word -> other words that mean the same here (each side is matched at word starts, never as a substring).
  const SYNONYMS = {
    mode: ['theme'], night: ['dark'], dim: ['dark'], appearance: ['theme'], colour: ['color'], colours: ['color'],
    adblock: ['tracker', 'trackers', 'ads'], adblocker: ['tracker', 'trackers', 'ads'], ads: ['tracker', 'trackers'], advert: ['ads', 'tracker'], tracking: ['tracker', 'trackers'],
    password: ['passwords', 'logins', 'sign-in'], login: ['logins', 'passwords', 'sign-in'],
    history: ['browsing data'], cache: ['browsing data'], cookie: ['cookies', 'site data'],
    vpn: ['proxy'], network: ['proxy'], lag: ['performance', 'graphics'], slow: ['performance', 'sleep', 'memory'], speed: ['performance'],
    ram: ['memory'], battery: ['sleep', 'memory'], gpu: ['graphics', 'acceleration'],
    font: ['text size', 'zoom'], zoom: ['text size', 'page zoom'], big: ['zoom', 'text size'], bigger: ['zoom', 'text size'],
    startup: ['on startup', 'launch'], homepage: ['new tab', 'startup'], home: ['new tab'], wallpaper: ['background'],
    update: ['updates', 'version'], upgrade: ['updates', 'version'], version: ['updates', 'about'],
    language: ['languages', 'translate', 'spelling'], translate: ['translation', 'languages'], spelling: ['spell check'], spellcheck: ['spell check', 'spelling'],
    download: ['downloads', 'save'], save: ['downloads'], folder: ['downloads', 'location'],
    // (a provider's name finds its own rows and its group, never every AI row: no 'ai' synonym)
    chatgpt: ['openai'], claude: ['anthropic'], gemini: ['google'], grok: ['xai'], assistant: ['ai model'], llm: ['ai model'],
    reset: ['defaults', 'restore'], backup: ['export', 'import'], bookmarks: ['import', 'favorites'], favourites: ['favorites'],
    mic: ['microphone'], webcam: ['camera'], gps: ['location'], popup: ['pop-ups'], popups: ['pop-ups'], notification: ['notifications'],
    shortcut: ['keyboard', 'keys'], shortcuts: ['keyboard', 'keys'], accessibility: ['reduce motion', 'contrast', 'text size'],
    autofill: ['passwords', 'logins'],
  };

  const isWordChar = (c) => /[a-z0-9]/.test(c);
  // Does `word` start a word somewhere in `text` (both lower case)? A phrase with a space has to start at a word start too.
  function hasWord(text, word) {
    for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) if (i === 0 || !isWordChar(text[i - 1])) return true;
    return false;
  }
  // The query word and what else it can mean.
  // ("agents" also finds "agent", "cookies" "cookie": a plural is looked up as its singular too)
  const singular = (word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? [word.slice(0, -1)] : []);
  const alternatives = (word) => [word, ...singular(word), ...(SYNONYMS[word] || [])];
  const matchesWord = (text, word) => alternatives(word).some((a) => hasWord(text, a));
  const matchesAll = (text, words) => words.every((w) => matchesWord(text, w));
  const parse = (query) => String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);

  // 0 = no match. A row: 3 when the label matches, 2 when its group or page title or the names of its choices do
  // (Theme: light, dark, system), 1 when only its description does. `titles` is the group title plus the page's, `label` the row's label.
  function score(words, { label = '', titles = '', search = '', keywords = '' }) {
    if (!words.length) return 0;
    const l = label.toLowerCase();
    if (matchesAll(l, words)) return 3;
    if (matchesAll(`${l} ${titles} ${keywords}`.toLowerCase(), words)) return 2;
    return matchesAll(`${search} ${titles}`.toLowerCase(), words) ? 1 : 0;
  }

  // Does the query name this whole page ("AI and agents")? Only when it holds the title's first word and nothing else the title lacks:
  // "ai", "ai agents" and "privacy" do, "agents" does not. (A word of three letters or more may be the start of the title's word.)
  const STOP = new Set(['and', 'the', 'of', 'for', 'to', 'a', 'an']);
  function categoryHit(words, title) {
    const t = parse(title).filter((w) => !STOP.has(w));
    const q = words.filter((w) => !STOP.has(w));
    if (!t.length || !q.length) return false;
    const is = (w, x) => (w.length >= 3 ? x.startsWith(w) : x === w);
    return q.every((w) => t.some((x) => is(w, x))) && q.some((w) => is(w, t[0]));
  }

  // The words a row is searched with besides its label: its group's title, its sub-page's, and its page's when the query is about that page.
  const titlesFor = (words, { group = '', sub = '', cat = '' }) => `${group} ${sub} ${categoryHit(words, cat) ? cat : ''}`.toLowerCase();
  // 0..3 for one row (a group or page title that matches lifts every row in it to 2).
  const rowScore = (words, titles, { label = '', search = '', keywords = '' }) => Math.max(matchesAll(titles, words) ? 2 : 0, score(words, { label, titles, search, keywords }));
  // Description-only hits are noise when something is named by the query: once a label or title matches anywhere, a row needs 2 to show.
  const floorFor = (words, items) => (items.some(({ label = '', titles }) => score(words, { label }) === 3 || matchesAll(titles, words)) ? 2 : 1);
  // The whole ranking for a list of rows {label, group, sub, cat, search, keywords}: each row's score, 0 when it is filtered out.
  function rank(words, rows) {
    if (!words.length) return rows.map(() => 0);
    const items = rows.map((r) => ({ ...r, titles: titlesFor(words, r) }));
    const floor = floorFor(words, items);
    return items.map((r) => { const s = rowScore(words, r.titles, r); return s >= floor ? s : 0; });
  }

  const api = { SYNONYMS, hasWord, matchesWord, matchesAll, parse, score, categoryHit, titlesFor, rowScore, floorFor, rank };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.settingsSearch = api;
})();
