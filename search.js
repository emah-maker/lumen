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

// Address bar input: a URL to open, or words to search for. A dotted word counts as a site only
// when it ends in a real top-level domain (tlds.js), so "github.com" and "foo.dev" open while
// "node.js" and "notes.txt" are searched. `javascript:` never runs from here: pasting it is a
// classic trick to make someone run script on the site they're on, so it is searched as text.
const TLDS = require('./tlds');
const LOCAL_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#]|$)/i;
function resolveInput(text, engineId) {
  const value = String(text || '').trim();
  const search = () => searchUrlFor(engineId, value);
  if (!value || /^javascript:/i.test(value)) return search();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(about|mailto|tel):/i.test(value)) return value;
  if (/\s/.test(value)) return search();
  if (LOCAL_HOST.test(value) || /^[^/?#]+\.localhost(:\d+)?([/?#]|$)/i.test(value)) return `http://${value}`;
  const host = value.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  if (host.includes('@') || !/^[^.:]+(\.[^.:]+)+$/.test(host)) return search();
  let tld = host.slice(host.lastIndexOf('.') + 1).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(tld)) { // an internationalized name: compare its punycode form
    try { tld = new URL(`http://${host}`).hostname.split('.').pop(); } catch { return search(); }
  }
  return TLDS.has(tld) ? `https://${value}` : search();
}

module.exports = { SEARCH_ENGINES, DEFAULT_ENGINE, engineFor, searchUrlFor, resolveInput };
