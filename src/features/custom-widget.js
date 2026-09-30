// Custom widgets, the pure part: a "recipe" is a small JSON description of a card that anyone can
// write and share (docs/custom-widgets.md). It names one https JSON address, and which values in the
// answer to show as numbers (stats) or as a list. No code runs: features/widgets.js fetches the
// address (no cookies, size and rate limits), shape() picks the values out as plain strings, and the
// new-tab page draws them with textContent. A shared recipe can only ever show text from its address.
//
//   cleanRecipe(r)          a recipe -> its checked form; throws an Error saying what is wrong
//   get(obj, path)          one value by a path like "data.items[0].price" (own properties only)
//   shape(json, recipe)     the answer -> { stats: [{ label, value }], items: [{ title, detail, url }] }
//   EXAMPLES                recipes Settings offers as a starting point
'use strict';

const VIEWS = ['stats', 'list'];
const MAX_STATS = 6;
const MAX_ITEMS = 20;
const PATH_RE = /^(?:[A-Za-z_$][\w$-]{0,63}|\[\d{1,4}\])(?:\.[A-Za-z_$][\w$-]{0,63}|\.\d{1,4}|\[\d{1,4}\])*$/;
const BLOCKED = new Set(['__proto__', 'prototype', 'constructor']);

const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

function cleanUrl(v) {
  let u;
  try { u = new URL(typeof v === 'string' ? v.trim() : ''); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.href.length > 2000) return null;
  return u.href;
}
// A path is optional where noted; '' means "not set". Throws on one that can't be a path.
function cleanPath(v, what, optional = false) {
  const p = str(v, 200);
  if (!p) { if (optional) return ''; throw new Error(`Add a path for ${what}.`); }
  if (!PATH_RE.test(p) || p.split(/[.[\]]/).some((k) => BLOCKED.has(k))) throw new Error(`“${p}” isn’t a path Lumen can read (use names and [0]-style indexes, like data.items[0].price).`);
  return p;
}

function cleanRecipe(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('A recipe is a JSON object, like { "url": "https://…", "stats": [ … ] }.');
  const url = cleanUrl(r.url);
  if (!url) throw new Error('The recipe needs a "url" that starts with https://.');
  const every = Number.isFinite(Number(r.every)) ? Math.min(1440, Math.max(5, Math.round(Number(r.every)))) : 30;
  const view = VIEWS.includes(r.view) ? r.view : Array.isArray(r.stats) && r.stats.length ? 'stats' : 'list';
  const out = { name: str(r.name, 60), url, every, view, stats: [], list: null };
  if (view === 'stats') {
    const stats = Array.isArray(r.stats) ? r.stats : [];
    if (!stats.length) throw new Error('A "stats" recipe needs at least one entry in "stats".');
    if (stats.length > MAX_STATS) throw new Error(`At most ${MAX_STATS} stats.`);
    out.stats = stats.map((s, i) => {
      if (!s || typeof s !== 'object') throw new Error(`Stat ${i + 1} must be an object with a "path".`);
      const decimals = Number.isInteger(s.decimals) && s.decimals >= 0 && s.decimals <= 6 ? s.decimals : null;
      return { label: str(s.label, 40) || `Value ${i + 1}`, path: cleanPath(s.path, `stat ${i + 1}`), prefix: str(s.prefix, 8), suffix: str(s.suffix, 12), decimals };
    });
  } else {
    const l = r.list && typeof r.list === 'object' ? r.list : null;
    if (!l) throw new Error('A "list" recipe needs a "list": { "path": …, "title": … }.');
    out.list = {
      path: cleanPath(l.path, 'the list', true), // '' = the answer itself is the array
      title: cleanPath(l.title, 'each item’s title'),
      detail: cleanPath(l.detail, 'each item’s detail', true),
      link: cleanPath(l.link, 'each item’s link', true),
      max: Number.isInteger(l.max) ? Math.min(MAX_ITEMS, Math.max(1, l.max)) : 8,
    };
  }
  return out;
}
// The same, but null instead of throwing (a stored recipe read back from settings).
function recipeOrNull(r) {
  try { return cleanRecipe(r); } catch { return null; }
}

function get(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const key of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object' || BLOCKED.has(key) || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function format(v, s = {}) {
  let t;
  if (typeof v === 'number' && Number.isFinite(v)) t = v.toLocaleString('en-US', s.decimals === null || s.decimals === undefined ? { maximumFractionDigits: 2 } : { minimumFractionDigits: s.decimals, maximumFractionDigits: s.decimals });
  else if (typeof v === 'string') t = str(v, 200);
  else if (typeof v === 'boolean') t = v ? 'Yes' : 'No';
  else return '–';
  return `${s.prefix || ''}${t}${s.suffix || ''}`;
}
const httpsLink = (v) => (typeof v === 'string' && cleanUrl(v)) || null;

function shape(json, recipe) {
  if (recipe.view === 'stats') {
    const stats = recipe.stats.map((s) => ({ label: s.label, value: format(get(json, s.path), s) }));
    if (stats.every((s) => s.value === '–')) throw new Error('None of the recipe’s paths were found in the answer. Check them against what the address returns.');
    return { stats, items: [] };
  }
  const arr = get(json, recipe.list.path);
  if (!Array.isArray(arr)) throw new Error(recipe.list.path ? `“${recipe.list.path}” isn’t a list in the answer.` : 'The answer isn’t a list; set "list.path" to the list inside it.');
  const items = [];
  for (const it of arr) {
    if (items.length >= recipe.list.max) break;
    const title = format(get(it, recipe.list.title));
    if (title === '–') continue;
    items.push({ title, detail: recipe.list.detail ? format(get(it, recipe.list.detail)).replace(/^–$/, '') : '', url: recipe.list.link ? httpsLink(get(it, recipe.list.link)) : null });
  }
  return { stats: [], items };
}

const EXAMPLES = [
  { name: 'GitHub repo', url: 'https://api.github.com/repos/emah-maker/lumen', every: 60, view: 'stats', stats: [{ label: 'Stars', path: 'stargazers_count' }, { label: 'Forks', path: 'forks_count' }, { label: 'Open issues', path: 'open_issues_count' }] },
  { name: 'Hacker News', url: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=10', every: 15, view: 'list', list: { path: 'hits', title: 'title', detail: 'points', link: 'url', max: 8 } },
  { name: 'Dollar rates', url: 'https://open.er-api.com/v6/latest/USD', every: 720, view: 'stats', stats: [{ label: 'EUR', path: 'rates.EUR', decimals: 3, prefix: '€' }, { label: 'GBP', path: 'rates.GBP', decimals: 3, prefix: '£' }, { label: 'INR', path: 'rates.INR', decimals: 2, prefix: '₹' }] },
];

module.exports = { VIEWS, MAX_STATS, MAX_ITEMS, cleanRecipe, recipeOrNull, get, format, shape, EXAMPLES };
