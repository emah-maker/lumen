// Search engines the user can pick (address bar, new-tab page, context menu, suggestions).
const SEARCH_ENGINES = {
  google: { label: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { label: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  ecosia: { label: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
  startpage: { label: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
};
const DEFAULT_ENGINE = 'google';

const engineFor = (id) => SEARCH_ENGINES[id] || SEARCH_ENGINES[DEFAULT_ENGINE];
const searchUrlFor = (id, query) => engineFor(id).url.replace('%s', encodeURIComponent(query));

module.exports = { SEARCH_ENGINES, DEFAULT_ENGINE, engineFor, searchUrlFor };
