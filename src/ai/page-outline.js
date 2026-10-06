// read_page mode "outline": a cheap map of a page to navigate by before a full read: its headings, its links
// grouped by landmark (main, article, nav, footer, ...), a repeated block (a results list or card grid) and the
// next-page link. outlineDom walks a DOM (or the DOM-like tree page-markdown.js parses, which is how
// test/page-reading-units.js runs it on HTML strings) and returns plain data; formatOutline turns that into the
// text the model reads. outlineDom is self-contained (agent code serializes it into the page, like snapshot.js's
// extractData): it may only use its own arguments and the standard DOM, nothing from this module.

// body: the root element to walk. loc: { href } of the page. hooks: { hidden(el) } (optional, real pages only).
function outlineDom(body, loc, hooks = {}) {
  const BY_TAG = { NAV: 'nav', ASIDE: 'aside', MAIN: 'main', ARTICLE: 'article' };
  const BY_ROLE = { navigation: 'nav', banner: 'header', contentinfo: 'footer', complementary: 'aside', main: 'main', search: 'search', article: 'article' };
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|HEAD|IFRAME)$/i;
  const STATE = /^(odd|even|first|last|active|selected|current|open|show|hover|focus|visible|hidden)$/i;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const headings = [];
  const groups = new Map();
  const nextCands = [];
  let repeat = null;
  let repeatScore = 0;

  let here = null;
  try { here = new URL(loc.href); } catch {}
  const pageKey = /^(page|p|pg|paged|pagenumber)$/i;
  let curPage = 1;
  let pathPattern = null; // /page/N in the path
  if (here) {
    for (const [k, v] of here.searchParams) if (pageKey.test(k) && /^\d+$/.test(v)) curPage = Number(v);
    const m = /\/(page|p)\/(\d+)(?=\/|$)/.exec(here.pathname);
    if (m) { curPage = Number(m[2]); pathPattern = m[1]; }
  }
  // Is `url` this same listing, one page on?
  const isNextPageUrl = (url) => {
    if (!here || url.origin !== here.origin) return false;
    if (pathPattern) {
      const m = /\/(page|p)\/(\d+)(?=\/|$)/.exec(url.pathname);
      return Boolean(m) && m[1] === pathPattern && Number(m[2]) === curPage + 1 && url.pathname.replace(m[0], '') === here.pathname.replace(/\/(page|p)\/\d+(?=\/|$)/, '');
    }
    if (url.pathname !== here.pathname) return false;
    for (const [k, v] of url.searchParams) if (pageKey.test(k) && Number(v) === curPage + 1) return true;
    return false;
  };

  const regionOf = (el, inherited, scoped) => {
    const role = el.getAttribute('role');
    if (role && BY_ROLE[role]) return BY_ROLE[role];
    if (BY_TAG[el.tagName]) return BY_TAG[el.tagName];
    if ((el.tagName === 'HEADER' || el.tagName === 'FOOTER') && !scoped) return el.tagName.toLowerCase(); // inside an article a header is the article's
    return inherited;
  };
  const hiddenAttr = (el) => el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true' || /display:\s*none/i.test(el.getAttribute('style') || '');
  const hidden = (el) => hiddenAttr(el) || (hooks.hidden ? hooks.hidden(el) : false);
  const label = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ((el.className && typeof el.className === 'string' && el.className.trim().split(/\s+/).find((c) => !STATE.test(c))) ? `.${el.className.trim().split(/\s+/).find((c) => !STATE.test(c))}` : '')}`;
  const sigOf = (el) => `${el.tagName}.${(typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter((c) => c && !STATE.test(c)).sort().join('.')}`;

  const addLink = (el, region) => {
    const raw = (el.getAttribute('href') || '').trim();
    if (!raw || /^(javascript:|mailto:|tel:|#)/i.test(raw)) return;
    const img = Array.from(el.children).find((c) => c.tagName === 'IMG');
    const text = clean(el.textContent) || clean(el.getAttribute('aria-label')) || clean(el.getAttribute('title')) || (img ? clean(img.getAttribute('alt')) : '');
    let url;
    try { url = new URL(raw, loc.href); } catch { return; }
    if (!/^https?:$/.test(url.protocol)) return;
    const rel = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    const disabled = el.getAttribute('aria-disabled') === 'true' || /\bdisabled\b/.test(typeof el.className === 'string' ? el.className : '');
    if (!disabled && !hidden(el)) {
      let rank = 0;
      if (rel.includes('next')) rank = 1;
      else if (/^(next( page)?( ?[›»→>])?|older( posts)?|[›»→>]+|load more|show more|more results)$/i.test(text) || /^next\b/i.test(clean(el.getAttribute('aria-label')))) rank = 2;
      else if (isNextPageUrl(url)) rank = 3;
      if (rank) nextCands.push({ rank, text: text || 'Next', href: url.href });
    }
    if (!text || hidden(el)) return;
    const shown = here && url.origin === here.origin ? `${url.pathname}${url.search}` : url.href;
    let g = groups.get(region);
    if (!g) groups.set(region, (g = { region, count: 0, links: [], seen: new Set() }));
    const key = `${shown}\n${text}`;
    if (g.seen.has(key)) return;
    g.seen.add(key);
    g.count++;
    if (g.links.length < 40) g.links.push({ text: text.slice(0, 90), href: shown.slice(0, 140) });
  };

  const consider = (el, region) => {
    const kids = Array.from(el.children);
    if (kids.length < 4) return;
    const tally = new Map();
    for (const k of kids) { if (!SKIP.test(k.tagName)) tally.set(sigOf(k), (tally.get(sigOf(k)) || 0) + 1); }
    let best = null;
    for (const [sig, n] of tally) if (!best || n > best.n) best = { sig, n };
    if (!best || best.n < 4 || best.n < kids.length * 0.6) return;
    const sample = kids.find((k) => sigOf(k) === best.sig);
    const text = clean(sample.textContent);
    if (text.length < 6) return;
    const score = best.n * (region === 'nav' || region === 'header' || region === 'footer' ? 0.2 : 1) + Math.min(text.length, 200) / 1000;
    if (score <= repeatScore) return;
    repeatScore = score;
    const path = [];
    for (let n = el; n && path.length < 3 && n !== body && n.tagName !== 'BODY' && n.tagName !== '#ROOT'; n = n.parentElement) path.unshift(label(n));
    repeat = { path: path.join(' > '), count: best.n, tag: sample.tagName.toLowerCase(), sample: text.slice(0, 60) };
  };

  const walk = (el, region, scoped) => {
    if (SKIP.test(el.tagName) || hiddenAttr(el)) return;
    const r = regionOf(el, region, scoped);
    const s = scoped || /^(ARTICLE|MAIN|SECTION|ASIDE)$/.test(el.tagName);
    if (el.tagName === 'A') { addLink(el, r); }
    else if (/^H[1-3]$/.test(el.tagName)) {
      const text = clean(el.textContent);
      if (text && headings.length < 60 && !hidden(el)) headings.push({ level: Number(el.tagName[1]), text: text.slice(0, 100) });
    }
    consider(el, r);
    for (const c of Array.from(el.children)) walk(c, r, s);
  };
  walk(body, 'page', false);
  nextCands.sort((a, b) => a.rank - b.rank);
  return { headings, groups: [...groups.values()].map(({ region, count, links }) => ({ region, count, links })), repeat, next: nextCands[0] || null };
}

// Content landmarks first, then the page chrome.
const REGION_ORDER = ['main', 'article', 'page', 'aside', 'search', 'nav', 'header', 'footer'];
const REGION_NAME = { page: 'page (outside landmarks)' };
const MAX_LINKS = 15;

// outline: outlineDom's result. extra: { title, url, healthLine, structured } (strings).
function formatOutline(outline, { title = '', url = '', healthLine = '', structured = '' } = {}) {
  const lines = [`Outline of: ${title || '(untitled)'}`, `URL: ${url}`];
  if (healthLine) lines.push(healthLine);
  if (structured) lines.push(structured);
  if (outline.headings.length) {
    const top = Math.min(...outline.headings.map((h) => h.level));
    lines.push('Headings:');
    for (const h of outline.headings.slice(0, 40)) lines.push(`${'  '.repeat(h.level - top)}${'#'.repeat(h.level)} ${h.text}`);
    if (outline.headings.length > 40) lines.push(`(+${outline.headings.length - 40} more headings)`);
  } else lines.push('Headings: none');
  if (outline.repeat) lines.push(`Repeated block: ${outline.repeat.path}: ${outline.repeat.count} items like '${outline.repeat.sample}${outline.repeat.sample.length >= 60 ? '…' : ''}'`);
  if (outline.next) lines.push(`Next page: [${outline.next.text}](${outline.next.href})`);
  const groups = [...outline.groups].sort((a, b) => REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region));
  if (groups.length) {
    lines.push('Links by region:');
    for (const g of groups) {
      lines.push(`${REGION_NAME[g.region] || g.region} (${g.count}):`);
      for (const l of g.links.slice(0, MAX_LINKS)) lines.push(`- ${l.text} → ${l.href}`);
      if (g.count > MAX_LINKS) lines.push(`  (+${g.count - MAX_LINKS} more)`);
    }
  } else lines.push('Links: none');
  lines.push('Read a part with read_page mode:"full" or navigate to a link.');
  return `<untrusted_page_content>\n${lines.join('\n')}\n</untrusted_page_content>`;
}

module.exports = { outlineDom, formatOutline, REGION_ORDER, MAX_LINKS };
