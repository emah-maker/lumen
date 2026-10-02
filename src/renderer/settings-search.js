// Settings search: which settings a query finds, and how well. Plain functions (no DOM), shared by settings.js and the
// unit tests (test/settings-search-units.js).
//  - A query word matches where a word of the setting starts with it ("mode" finds "Dark mode", not "Model").
//  - A few everyday words also match what the setting calls it ("night" finds the dark theme, "adblock" the tracker blocker).
//  - Every query word must match; a hit in the label beats one in the group title, which beats one in the helper text.
(function () {
  // query word -> other words that mean the same here (each side is matched at word starts, never as a substring).
  const SYNONYMS = {
    night: ['dark'], dim: ['dark'], appearance: ['theme'], colour: ['color'], colours: ['color'],
    adblock: ['tracker', 'trackers', 'ads'], adblocker: ['tracker', 'trackers', 'ads'], ads: ['tracker', 'trackers'], advert: ['ads', 'tracker'], tracking: ['tracker', 'trackers'],
    password: ['passwords', 'logins', 'sign-in'], login: ['logins', 'passwords', 'sign-in'],
    history: ['browsing data', 'clear'], cache: ['browsing data', 'clear'], cookie: ['cookies', 'site data'],
    vpn: ['proxy'], network: ['proxy'], lag: ['performance', 'graphics'], slow: ['performance', 'sleep', 'memory'], speed: ['performance'],
    ram: ['memory'], battery: ['sleep', 'memory'], gpu: ['graphics', 'acceleration'],
    font: ['text size', 'zoom'], zoom: ['text size', 'page zoom'], big: ['zoom', 'text size'], bigger: ['zoom', 'text size'],
    startup: ['on startup', 'launch'], homepage: ['new tab', 'startup'], home: ['new tab'], wallpaper: ['background'],
    update: ['updates', 'version'], upgrade: ['updates', 'version'], version: ['updates', 'about'],
    language: ['languages', 'translate', 'spelling'], translate: ['translation', 'languages'], spelling: ['spell check'], spellcheck: ['spell check', 'spelling'],
    download: ['downloads', 'save'], save: ['downloads'], folder: ['downloads', 'location'],
    chatgpt: ['ai', 'openai'], claude: ['ai', 'anthropic'], gemini: ['ai', 'google'], grok: ['ai', 'xai'], assistant: ['ai', 'model'], llm: ['ai', 'model'],
    reset: ['defaults', 'restore'], backup: ['export', 'import'], bookmarks: ['import', 'favorites'], favourites: ['favorites'],
    shortcut: ['keyboard', 'keys'], shortcuts: ['keyboard', 'keys'], accessibility: ['reduce motion', 'contrast', 'text size'],
  };

  const isWordChar = (c) => /[a-z0-9]/.test(c);
  // Does `word` start a word somewhere in `text` (both lower case)? A phrase with a space has to start at a word start too.
  function hasWord(text, word) {
    for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) if (i === 0 || !isWordChar(text[i - 1])) return true;
    return false;
  }
  // The query word and what else it can mean.
  const alternatives = (word) => [word, ...(SYNONYMS[word] || [])];
  const matchesWord = (text, word) => alternatives(word).some((a) => hasWord(text, a));
  const matchesAll = (text, words) => words.every((w) => matchesWord(text, w));
  const parse = (query) => String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);

  // 0 = no match. A row: 3 when the label matches, 2 when its group or page title does, 1 when only its description
  // or option names do. `titles` is the group title plus the page's, `label` the row's label.
  function score(words, { label = '', titles = '', search = '' }) {
    if (!words.length) return 0;
    const l = label.toLowerCase();
    if (matchesAll(l, words)) return 3;
    if (matchesAll(`${l} ${titles}`.toLowerCase(), words)) return 2;
    return matchesAll(`${search} ${titles}`.toLowerCase(), words) ? 1 : 0;
  }

  const api = { SYNONYMS, hasWord, matchesWord, matchesAll, parse, score };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.settingsSearch = api;
})();
