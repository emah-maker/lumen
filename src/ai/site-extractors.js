// Per-site readers for the AI's read tools (read_urls, and read_page on a supported tab). A cluttered DOM walk
// of a Reddit thread, a YouTube watch page or a tweet is slow, noisy and cut at a few thousand characters; these
// sites expose the same content in a compact form (RSS, JSON, a transcript), so for a supported address the tools
// answer from that instead and only fall back to the normal page read when it fails.
//
// Pure: no Electron, no network of its own. The caller passes `get` (a cookie-less fetch, see makeGet) so the module
// is unit-tested with fixtures. Read-only: every request is a GET (YouTube's player lookup is a POST that only reads).
//
//   extractorFor(url)                  -> extractor | null  (null: not a supported address, e.g. reddit.com/settings)
//   readSite(url, { get, maxChars })   -> { title, text, source } | null   (null / any error: use the normal read)
//   readSiteInPage(url, runScript, o)  -> same, from an already loaded page (an extractor with `inPage`)
//
// Each extractor: { name, matches(url), read(url, ctx), inPage?: script string, formatPage?(raw, opts) }.
// `ctx` = { get(url, { accept, method, body, headers }) -> { ok, status, text, url }, maxChars, sleep, now, lang }.
// The text always starts with `Source: <site> (<how>)`; the caller wraps it in <untrusted_page_content>.
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const DEFAULT_MAX_CHARS = 8000;
const TIMEOUT_MS = 10000;
const COMMENT_CAP = 400;

// Hosts a request may end up on after redirects (a redirect anywhere else is a failed request).
const ALLOWED_HOSTS = ['reddit.com', 'ycombinator.com', 'algolia.com', 'youtube.com', 'youtu.be', 'twimg.com', 'twitter.com', 'x.com', 'tiktok.com', 'github.com', 'githubusercontent.com'];
const hostAllowed = (host) => ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

// ---------- small helpers ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') {
      const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : Number(k.slice(1));
      try { return Number.isFinite(n) ? String.fromCodePoint(n) : m; } catch { return m; }
    }
    return ENTITIES[k] ?? m;
  });
}

// HTML (a Reddit/HN comment body) -> plain text with paragraph breaks and links kept as `text (url)`.
function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<a\b[^>]*\bhref=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (m, a, b, inner) => {
    const href = decodeEntities(a ?? b ?? '');
    const text = decodeEntities(inner.replace(/<[^>]*>/g, '')).trim();
    const urlish = /^https?:\/\//i.test(text);
    if (!/^https?:/i.test(href) || !text || text === href || urlish || text.endsWith('…')) return urlish && /^https?:/i.test(href) ? href : text || href;
    return `${text} (${href})`;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/(p|div|li|h[1-6]|pre|blockquote|tr|ul|ol)>/gi, '\n').replace(/<p\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s).replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const oneLine = (s) => String(s ?? '').replace(/\s*\n+\s*/g, ' ¶ ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…` : s);

function fmtCount(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const f = (v, suffix) => `${(Math.round(v * 10) / 10).toString().replace(/\.0$/, '')}${suffix}`;
  if (abs < 1000) return String(n);
  if (abs < 1e6) return abs < 1e5 ? f(n / 1000, 'k') : `${Math.round(n / 1000)}k`;
  return f(n / 1e6, 'M');
}

// "3h" style age; `ts` in ms (or an ISO string).
function ago(ts, now = Date.now()) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}mo`;
  return `${Math.floor(s / 86400 / 365)}y`;
}

const parts = (...xs) => xs.filter((x) => x !== '' && x != null && x !== false).join(' · ');
const parseUrl = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; } };
const bareHost = (u) => u.hostname.toLowerCase().replace(/^www\./, '');
const domainOf = (href) => { try { return new URL(href).hostname.replace(/^www\./, ''); } catch { return ''; } };
const cap = (text, maxChars, note = '') => (text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1 - note.length)).trimEnd()}…${note}` : text);

// ---------- comment lines (shared by Reddit and Hacker News) ----------

// items: [{ depth, author, score, ts, text, flags: [], more?: n }] in thread order. One line each:
//   [d2] u/name 1.2k · 3h (OP): text…
// Fits `budget` characters: the deepest levels go first (the largest depth that fits is kept, replies deeper than
// that are counted), then, if even the top level is too long, the tail is cut. Returns { lines, omitted }.
function renderComments(items, budget, { prefix = 'u/', per = COMMENT_CAP, now = Date.now() } = {}) {
  const line = (c) => {
    const d = c.depth == null ? '-' : `d${c.depth}`;
    if (c.more) return `[${d}] +${c.more} more ${c.more === 1 ? 'reply' : 'replies'}`;
    const flags = (c.flags || []).length ? ` (${c.flags.join(', ')})` : '';
    const meta = parts(c.score != null ? fmtCount(c.score) : '', c.ts ? ago(c.ts, now) : '');
    const body = clip(oneLine(c.text) || '[no text]', per);
    return `[${d}] ${prefix}${c.author || '[deleted]'}${flags}${meta ? ` ${meta}` : ''}: ${body}`;
  };
  const size = (list) => list.reduce((n, c) => n + line(c).length + 1, 0);
  const deepest = items.reduce((m, c) => Math.max(m, c.depth ?? 0), 0);
  let keep = items;
  let depthCut = null;
  for (let d = deepest; d >= 0; d--) {
    keep = items.filter((c) => (c.depth ?? 0) <= d);
    if (size(keep) <= budget || d === 0) { depthCut = d < deepest ? d : null; break; }
  }
  const lines = [];
  let used = 0;
  let shown = 0;
  for (const c of keep) {
    const l = line(c);
    if (used + l.length + 1 > budget) break;
    lines.push(l);
    used += l.length + 1;
    shown++;
  }
  const real = (list) => list.filter((c) => !c.more).length;
  const cutDepth = depthCut == null ? 0 : real(items) - real(keep);
  const cutTail = real(keep) - real(keep.slice(0, shown));
  const notes = [];
  if (cutDepth) notes.push(`${cutDepth} replies deeper than d${depthCut} not shown`);
  if (cutTail) notes.push(`${cutTail} more comments not shown (size limit)`);
  return { lines, omitted: notes.join('; ') };
}

// ---------- Reddit ----------

const REDDIT_HOSTS = new Set(['reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com', 'm.reddit.com', 'amp.reddit.com', 'i.reddit.com']);
const REDDIT_SORTS = new Set(['hot', 'new', 'top', 'rising', 'controversial', 'best', 'relevance', 'comments']);
const USER_TABS = new Set(['', 'submitted', 'comments', 'overview', 'posts']);

// URL -> { kind: 'thread'|'listing'|'user'|'search', path, query } | null. Only addresses that have a feed.
function redditTarget(url) {
  const u = parseUrl(url);
  if (!u || !REDDIT_HOSTS.has(bareHost(u))) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  const keep = new URLSearchParams();
  for (const k of ['sort', 't', 'q', 'restrict_sr', 'limit']) if (u.searchParams.has(k)) keep.set(k, u.searchParams.get(k));
  const make = (kind, s) => ({ kind, path: `/${s.join('/')}`, query: keep });
  if (seg[0] === 'r' && seg[1]) {
    if (seg[2] === 'comments' && /^[a-z0-9]{4,10}$/i.test(seg[3] || '')) return make('thread', seg.slice(0, seg[5] ? 6 : seg[4] ? 5 : 4)); // + slug + comment id (a focused sub-thread)
    if (seg[2] === 'search') return make('search', seg.slice(0, 3));
    if (seg.length === 2) return make('listing', seg);
    if (seg.length === 3 && REDDIT_SORTS.has(seg[2])) return make('listing', seg);
    return null; // wiki, about, submit, ...
  }
  if (seg[0] === 'comments' && /^[a-z0-9]{4,10}$/i.test(seg[1] || '')) return make('thread', seg.slice(0, 2));
  if ((seg[0] === 'user' || seg[0] === 'u') && seg[1] && seg.length <= 3 && USER_TABS.has(seg[2] || '')) return make('user', ['user', seg[1], ...(seg[2] && seg[2] !== 'overview' ? [seg[2]] : [])]);
  if (seg[0] === 'search' && seg.length === 1 && keep.has('q')) return make('search', seg);
  return null;
}

function redditRequests(t) {
  const q = new URLSearchParams(t.query);
  const limit = t.kind === 'thread' ? '200' : '50';
  const json = new URLSearchParams(q); json.set('raw_json', '1'); if (!json.has('limit')) json.set('limit', limit);
  const rss = new URLSearchParams(q); if (!rss.has('limit')) rss.set('limit', t.kind === 'thread' ? '100' : '50');
  return [
    { how: 'json', url: `https://www.reddit.com${t.path}.json?${json}`, accept: 'application/json' },
    { how: 'rss', url: `https://old.reddit.com${t.path}/.rss?${rss}`, accept: 'application/atom+xml, application/xml' },
    { how: 'rss', url: `https://www.reddit.com${t.path}/.rss?${rss}`, accept: 'application/atom+xml, application/xml' },
  ];
}

// A model-neutral post / comment shape; JSON, RSS and the DOM all produce it.
function redditPostFromJson(d) {
  const removed = Boolean(d.removed_by_category) || d.selftext === '[removed]' || d.selftext === '[deleted]';
  return {
    id: d.name || `t3_${d.id}`, title: decodeEntities(d.title), sub: d.subreddit, author: d.author, score: d.score, comments: d.num_comments,
    ts: d.created_utc ? d.created_utc * 1000 : null, flair: d.link_flair_text || '', nsfw: Boolean(d.over_18), spoiler: Boolean(d.spoiler), locked: Boolean(d.locked),
    stickied: Boolean(d.stickied), quarantine: Boolean(d.quarantine), removed, domain: d.is_self ? '' : (d.domain || domainOf(d.url)),
    url: d.is_self ? '' : d.url_overridden_by_dest || d.url || '', text: removed && !d.selftext ? '' : d.selftext || '',
    permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : '', ups: d.ups,
  };
}

function flattenRedditJsonComments(children, out = [], depth = 0, op = '') {
  for (const ch of children || []) {
    if (ch.kind === 'more') {
      const n = Number(ch.data?.count) || (ch.data?.children || []).length;
      if (n) out.push({ more: n, depth: Number.isFinite(ch.data?.depth) ? ch.data.depth : depth });
      continue;
    }
    if (ch.kind !== 't1') continue;
    const d = ch.data;
    const flags = [];
    if (d.is_submitter || (op && d.author === op)) flags.push('OP');
    if (d.distinguished === 'moderator') flags.push('mod');
    else if (d.distinguished) flags.push(d.distinguished);
    if (d.stickied) flags.push('pinned');
    out.push({ depth: Number.isFinite(d.depth) ? d.depth : depth, author: d.author, score: d.score_hidden ? null : d.score, ts: d.created_utc ? d.created_utc * 1000 : null, text: d.body || '', flags });
    if (d.replies && d.replies.data) flattenRedditJsonComments(d.replies.data.children, out, depth + 1, op);
  }
  return out;
}

// -> { type: 'thread', post, comments } | { type: 'list', title, items: [post|comment] } | { type: 'gone', reason } | null (not Reddit JSON)
function parseRedditJson(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (j && !Array.isArray(j) && j.reason) return { type: 'gone', reason: String(j.reason) };
  if (Array.isArray(j) && j[0]?.data?.children?.[0]?.kind === 't3') {
    const post = redditPostFromJson(j[0].data.children[0].data);
    return { type: 'thread', post, comments: flattenRedditJsonComments(j[1]?.data?.children, [], 0, post.author) };
  }
  if (j?.kind === 'Listing') {
    const items = (j.data?.children || []).map((c) => (c.kind === 't3' ? { type: 'post', ...redditPostFromJson(c.data) }
      : c.kind === 't1' ? { type: 'comment', author: c.data.author, sub: c.data.subreddit, score: c.data.score, ts: c.data.created_utc * 1000, text: c.data.body, postTitle: c.data.link_title, permalink: c.data.permalink ? `https://www.reddit.com${c.data.permalink}` : '' } : null)).filter(Boolean);
    return { type: 'list', title: '', items };
  }
  return null;
}

// Atom feed -> entries { id, author, href, ts, title, html }.
function parseAtom(xml) {
  const entries = [];
  for (const m of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const tag = (name) => (new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(e) || [])[1] || '';
    entries.push({
      id: tag('id').trim(),
      author: decodeEntities(/<author>\s*<name>([\s\S]*?)<\/name>/.exec(e)?.[1] || '').replace(/^\/?u\//, '').trim(),
      href: decodeEntities(/<link\b[^>]*\bhref="([^"]*)"/.exec(e)?.[1] || ''),
      ts: Date.parse(tag('published') || tag('updated')) || null,
      title: decodeEntities(tag('title')).trim(),
      sub: decodeEntities(/<category\b[^>]*\blabel="r\/([^"]*)"/.exec(e)?.[1] || ''),
      html: decodeEntities(tag('content')),
    });
  }
  return { entries, feedTitle: decodeEntities(/<title>([\s\S]*?)<\/title>/.exec(String(xml).split('<entry>')[0])?.[1] || '').trim() };
}

function parseRedditRss(xml) {
  if (!/<feed\b/.test(String(xml)) || /<!doctype html|<html/i.test(String(xml).slice(0, 400))) return null;
  const { entries, feedTitle } = parseAtom(xml);
  const posts = entries.map((e) => {
    const isPost = e.id.startsWith('t3_');
    const sc = /<!-- SC_OFF -->([\s\S]*?)<!-- SC_ON -->/.exec(e.html);
    let body = sc ? sc[1] : e.html;
    body = body.split(/(?:&#32;|\s)*submitted by\b/)[0];
    let url = '';
    if (isPost) {
      const dest = [...e.html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>\s*\[link\]\s*<\/a>/g)][0]?.[1];
      const d = decodeEntities(dest || '');
      if (d && !/^https?:\/\/(?:www\.|old\.)?reddit\.com\/r\/[^/]+\/comments\//i.test(d)) url = d;
    }
    const text = sc || !isPost || !url ? htmlToText(body) : '';
    return { type: isPost ? 'post' : 'comment', id: e.id, title: e.title, author: e.author, sub: e.sub, ts: e.ts, permalink: e.href, text: /^\[link\]$/.test(text) ? '' : text, url, domain: url ? domainOf(url) : '', postTitle: isPost ? '' : e.title.replace(/^\/?u\/\S+ on /, '') };
  });
  return { entries: posts, feedTitle };
}

function redditHeader(p, now) {
  const head = parts(p.sub ? `r/${p.sub}` : '', p.author ? `u/${p.author}` : '', p.score != null ? `${fmtCount(p.score)} pts` : '', p.comments != null ? `${fmtCount(p.comments)} comments` : '', p.ts ? `${ago(p.ts, now)} ago` : '',
    p.flair ? `flair: ${p.flair}` : '', p.nsfw ? 'NSFW' : '', p.spoiler ? 'spoiler' : '', p.locked ? 'locked' : '', p.stickied ? 'pinned' : '', p.quarantine ? 'quarantined' : '');
  return [head, p.domain ? `Link: ${p.url} (${p.domain})` : '', p.removed ? '[removed by moderators or the author]' : ''].filter(Boolean);
}

function formatRedditThread(model, how, { maxChars = DEFAULT_MAX_CHARS, now = Date.now(), focused = false } = {}) {
  const { post, comments } = model;
  const head = [`Source: reddit (${how})`, ...redditHeader(post, now)];
  const selftext = post.text ? clip(post.text, Math.min(4000, Math.floor(maxChars * 0.4))) : '';
  const known = how === 'rss' ? 'Note: the RSS feed has no scores or reply nesting, and may list only the newest comments.' : '';
  const top = [...head, ...(selftext ? ['', selftext] : []), ...(known ? ['', known] : [])].join('\n');
  const real = comments.filter((c) => !c.more).length;
  const label = (n, total) => `\nComments (${n} of ${total}${post.comments && post.comments > total && how === 'json' ? `; the post has ${fmtCount(post.comments)}` : ''})${focused ? ', from the linked comment' : ''}:`;
  const room = Math.max(300, maxChars - top.length - 120);
  const { lines, omitted } = renderComments(comments, room, { now });
  const body = real ? `${label(lines.filter((l) => !/ \+\d+ more repl/.test(l)).length, real)}\n${lines.join('\n')}${omitted ? `\n[${omitted}]` : ''}` : '\n(No comments.)';
  return { title: post.title, text: cap(`${top}\n${body}`, maxChars) };
}

function formatRedditList(model, how, meta, { maxChars = DEFAULT_MAX_CHARS, now = Date.now() } = {}) {
  const head = `Source: reddit (${how})`;
  const lines = [];
  let used = head.length;
  let n = 0;
  for (const it of model.items) {
    n++;
    let l;
    if (it.type === 'comment') l = `${n}. [comment] u/${it.author || '?'}${it.sub ? ` in r/${it.sub}` : ''}${it.postTitle ? ` on "${clip(it.postTitle, 80)}"` : ''}${it.ts ? ` · ${ago(it.ts, now)} ago` : ''}${it.score != null ? ` · ${fmtCount(it.score)} pts` : ''}: ${clip(oneLine(it.text), 240)}\n   ${it.permalink}`;
    else {
      const m = parts(it.sub ? `r/${it.sub}` : '', it.author ? `u/${it.author}` : '', it.score != null ? `${fmtCount(it.score)} pts` : '', it.comments != null ? `${fmtCount(it.comments)} comments` : '', it.ts ? `${ago(it.ts, now)} ago` : '', it.domain, it.flair ? `[${it.flair}]` : '', it.nsfw ? 'NSFW' : '');
      l = `${n}. ${it.title} — ${m}\n   ${it.permalink}${it.text ? `\n   ${clip(oneLine(it.text), 200)}` : ''}`;
    }
    if (used + l.length + 1 > maxChars - 60) { lines.push(`[+${model.items.length - n + 1} more not shown (size limit)]`); break; }
    lines.push(l); used += l.length + 1;
  }
  return { title: meta.title, text: lines.length ? `${head}\n${lines.join('\n')}` : `${head}\n(Nothing listed.)` };
}

const goneText = (reason, t) => {
  const what = { private: 'a private community', quarantined: 'a quarantined community (Reddit requires a signed-in opt-in)', banned: 'a banned community', gated: 'a community behind a content warning' }[reason] || `unavailable (${reason})`;
  return { title: t.path, text: `Source: reddit\n${t.path} is ${what}; its posts cannot be read signed out.` };
};

const redditExtractor = {
  name: 'reddit',
  matches: (url) => Boolean(redditTarget(url)),
  async read(url, ctx) {
    const t = redditTarget(url);
    if (!t) return null;
    const opts = { maxChars: ctx.maxChars, now: ctx.now() };
    let retried = false;
    for (const req of redditRequests(t)) {
      let res;
      try { res = await ctx.get(req.url, { accept: req.accept }); } catch { continue; }
      if (res.status === 429 && !retried) { retried = true; await ctx.sleep(1500); try { res = await ctx.get(req.url, { accept: req.accept }); } catch { continue; } }
      if (!res.ok) {
        if (req.how === 'json') { try { const j = JSON.parse(res.text); if (j?.reason && (res.status === 403 || res.status === 404)) return goneText(String(j.reason), t); } catch {} }
        continue; // 403/429 or an HTML block page: the next source
      }
      if (req.how === 'json') {
        const m = parseRedditJson(res.text);
        if (!m) continue;
        if (m.type === 'gone') return goneText(m.reason, t);
        if (m.type === 'thread') return formatRedditThread(m, 'json', { ...opts, focused: t.path.split('/').length > 5 });
        if (m.items.length) return formatRedditList(m, 'json', { title: `Reddit ${t.kind}: ${t.path}` }, opts);
        continue;
      }
      const m = parseRedditRss(res.text);
      if (!m || !m.entries.length) continue;
      if (t.kind === 'thread') {
        const post = m.entries.find((e) => e.type === 'post');
        const comments = m.entries.filter((e) => e.type === 'comment').map((e) => ({ depth: null, author: e.author, ts: e.ts, text: e.text, flags: [] }));
        const p = post ? { ...post, text: post.text, comments: null } : { title: m.feedTitle, sub: '', author: '', text: '' };
        return formatRedditThread({ post: { ...p, title: p.title || m.feedTitle }, comments }, 'rss', opts);
      }
      return formatRedditList({ items: m.entries }, 'rss', { title: `Reddit ${t.kind}: ${m.feedTitle || t.path}` }, opts);
    }
    return null;
  },
};

// A loaded (or signed-in) Reddit page: the new shreddit custom elements. Runs in the page; returns plain data.
function redditPageProbe(doc) {
  const text = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const post = doc.querySelector('shreddit-post');
  const body = text(doc.body);
  if (!post) {
    const gone = /this community is private|private community|quarantined|has been banned|this post was removed|post was deleted/i.exec(body.slice(0, 4000));
    return { gone: gone ? gone[0] : '' };
  }
  const attr = (el, k) => el.getAttribute(k);
  const timeOf = (el) => { const t = el.querySelector('time'); return (t && t.getAttribute('datetime')) || attr(el, 'created-timestamp') || ''; };
  const comments = [...doc.querySelectorAll('shreddit-comment')].map((c) => {
    const bodyEl = c.querySelector('[slot="comment"]') || c.querySelector('div[id*="richtext"]') || c.querySelector('p');
    return { author: attr(c, 'author'), score: attr(c, 'score'), thingid: attr(c, 'thingid'), depth: attr(c, 'depth'), ts: timeOf(c), text: text(bodyEl), distinguished: attr(c, 'is-moderator') != null && attr(c, 'is-moderator') !== 'false' ? 'mod' : '', op: attr(c, 'is-author') != null && attr(c, 'is-author') !== 'false' };
  });
  const sel = post.querySelector('[slot="text-body"]');
  return {
    post: { title: attr(post, 'post-title'), sub: attr(post, 'subreddit-name'), author: attr(post, 'author'), permalink: attr(post, 'permalink'), type: attr(post, 'post-type'), score: attr(post, 'score'), comments: attr(post, 'comment-count'), ts: attr(post, 'created-timestamp'), flair: text(post.querySelector('[slot="post-flair"]')), nsfw: attr(post, 'nsfw') != null, spoiler: attr(post, 'spoiler') != null, domain: attr(post, 'domain') || '', url: attr(post, 'content-href') || '', text: text(sel) },
    comments,
  };
}

function formatRedditPage(raw, { maxChars = DEFAULT_MAX_CHARS, now = Date.now(), url = '' } = {}) {
  if (!raw) return null;
  if (!raw.post) return null; // a private / removed page: the plain page read shows Reddit's own notice
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const p = raw.post;
  const post = { title: p.title, sub: p.sub, author: p.author, score: num(p.score), comments: num(p.comments), ts: Date.parse(p.ts) || null, flair: p.flair, nsfw: p.nsfw, spoiler: p.spoiler, domain: p.domain && !/reddit\.com$/.test(p.domain) ? p.domain : '', url: p.url && /^https?:/.test(p.url) && p.domain && !/reddit\.com$/.test(p.domain) ? p.url : '', text: p.text };
  const comments = (raw.comments || []).filter((c) => c.text || c.author).map((c) => ({ depth: num(c.depth) ?? 0, author: c.author, score: num(c.score), ts: Date.parse(c.ts) || null, text: c.text, flags: [...(c.op || (post.author && c.author === post.author) ? ['OP'] : []), ...(c.distinguished ? [c.distinguished] : [])] }));
  return formatRedditThread({ post, comments }, 'page', { maxChars, now });
}

// ---------- Hacker News ----------

function hnTarget(url) {
  const u = parseUrl(url);
  if (!u || bareHost(u) !== 'news.ycombinator.com') return null;
  const p = u.pathname.replace(/\/+$/, '') || '/';
  if (p === '/item') { const id = u.searchParams.get('id'); return /^\d+$/.test(id || '') ? { kind: 'item', id } : null; }
  const tags = { '/': 'front_page', '/news': 'front_page', '/front': 'front_page', '/ask': 'ask_hn', '/show': 'show_hn', '/jobs': 'job', '/newest': 'story' };
  if (tags[p]) return { kind: 'list', tag: tags[p], newest: p === '/newest' };
  return null;
}

function flattenHn(children, out = [], depth = 0, op = '') {
  for (const c of children || []) {
    if (c.text == null && c.author == null) continue; // deleted
    out.push({ depth, author: c.author, score: c.points ?? null, ts: c.created_at, text: htmlToText(c.text || ''), flags: op && c.author === op ? ['OP'] : [] });
    flattenHn(c.children, out, depth + 1, op);
  }
  return out;
}

function formatHnItem(item, { maxChars = DEFAULT_MAX_CHARS, now = Date.now() } = {}) {
  const comments = flattenHn(item.children, [], 0, item.type === 'story' ? item.author : '');
  const isStory = item.type === 'story' || item.type === 'poll' || item.title;
  const head = [`Source: hacker news (algolia)`, parts(isStory ? 'Hacker News' : 'Hacker News comment', item.author ? `by ${item.author}` : '', item.points != null ? `${fmtCount(item.points)} pts` : '', `${fmtCount(comments.length)} comments`, item.created_at ? `${ago(item.created_at, now)} ago` : ''), item.url ? `Link: ${item.url} (${domainOf(item.url)})` : ''].filter(Boolean);
  const own = item.text ? clip(htmlToText(item.text), Math.min(4000, Math.floor(maxChars * 0.4))) : '';
  const top = [...head, ...(own ? ['', own] : [])].join('\n');
  const { lines, omitted } = renderComments(comments, Math.max(300, maxChars - top.length - 100), { prefix: '', now });
  const body = comments.length ? `\nComments (${lines.length} of ${comments.length}):\n${lines.join('\n')}${omitted ? `\n[${omitted}]` : ''}` : '\n(No comments.)';
  return { title: item.title || `Comment by ${item.author}`, text: cap(`${top}\n${body}`, maxChars) };
}

function formatHnList(j, { maxChars = DEFAULT_MAX_CHARS, now = Date.now() } = {}, title = 'Hacker News') {
  const lines = [];
  let used = 60;
  (j.hits || []).forEach((h, i) => {
    const id = h.objectID || h.story_id;
    const l = `${i + 1}. ${h.title || h.story_title} — ${parts(h.url ? domainOf(h.url) : '', h.points != null ? `${fmtCount(h.points)} pts` : '', h.num_comments != null ? `${fmtCount(h.num_comments)} comments` : '', h.author ? `by ${h.author}` : '', h.created_at ? `${ago(h.created_at, now)} ago` : '')}\n   ${h.url || ''}${h.url ? ' | ' : '   '}https://news.ycombinator.com/item?id=${id}`;
    if (used + l.length > maxChars) return;
    lines.push(l); used += l.length + 1;
  });
  return { title, text: `Source: hacker news (algolia)\n${lines.join('\n') || '(Nothing listed.)'}` };
}

const hnExtractor = {
  name: 'hackernews',
  matches: (url) => Boolean(hnTarget(url)),
  async read(url, ctx) {
    const t = hnTarget(url);
    if (!t) return null;
    const opts = { maxChars: ctx.maxChars, now: ctx.now() };
    if (t.kind === 'item') {
      const res = await ctx.get(`https://hn.algolia.com/api/v1/items/${t.id}`, { accept: 'application/json' });
      if (!res.ok) return null;
      const item = JSON.parse(res.text);
      return item && item.id ? formatHnItem(item, opts) : null;
    }
    const api = t.newest ? 'search_by_date' : 'search';
    const res = await ctx.get(`https://hn.algolia.com/api/v1/${api}?tags=${t.tag}&hitsPerPage=30`, { accept: 'application/json' });
    if (!res.ok) return null;
    const j = JSON.parse(res.text);
    return Array.isArray(j.hits) ? formatHnList(j, opts, `Hacker News: ${t.tag.replace('_', ' ')}`) : null;
  },
};

// ---------- YouTube ----------

function ytId(url) {
  const u = parseUrl(url);
  if (!u) return null;
  const h = bareHost(u);
  let id = null;
  if (h === 'youtu.be') id = u.pathname.split('/')[1];
  else if (h === 'youtube.com' || h === 'm.youtube.com' || h === 'music.youtube.com') {
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg[0] === 'watch') id = u.searchParams.get('v');
    else if (['shorts', 'live', 'embed', 'v'].includes(seg[0])) id = seg[1];
  }
  return /^[\w-]{11}$/.test(id || '') ? id : null;
}

// The JSON object that follows `marker` in `html` (balanced braces, string-aware), or null.
function jsonAfter(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf('{', i + marker.length);
  if (start < 0) return null;
  let depth = 0, str = false, esc = false;
  for (let k = start; k < html.length; k++) {
    const c = html[k];
    if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { try { return JSON.parse(html.slice(start, k + 1)); } catch { return null; } }
  }
  return null;
}

const trackName = (t) => t.name?.simpleText || (t.name?.runs || []).map((r) => r.text).join('') || t.languageCode;
// Manual track in the wanted language, then auto-generated in it, then any manual, then any auto, then the first.
function pickCaptionTrack(tracks, lang = 'en') {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const base = String(lang).toLowerCase().split('-')[0];
  const code = (t) => String(t.languageCode || '').toLowerCase();
  const inLang = (t) => code(t) === String(lang).toLowerCase() || code(t).split('-')[0] === base;
  const asr = (t) => t.kind === 'asr';
  return tracks.find((t) => inLang(t) && !asr(t)) || tracks.find((t) => inLang(t) && asr(t)) || tracks.find((t) => !asr(t)) || tracks.find(asr) || tracks[0];
}

// json3 or XML (srv3 `<p t d>` in ms, legacy `<text start dur>` in s) -> [{ t: seconds, text }]
function parseTranscript(body) {
  const s = String(body || '').trim();
  if (!s) return [];
  const cues = [];
  if (s[0] === '{') {
    let j;
    try { j = JSON.parse(s); } catch { return []; }
    for (const ev of j.events || []) {
      if (!Array.isArray(ev.segs)) continue;
      const text = ev.segs.map((g) => g.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (text) cues.push({ t: (ev.tStartMs || 0) / 1000, text });
    }
    return cues;
  }
  for (const m of s.matchAll(/<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = decodeEntities(decodeEntities(m[2].replace(/<[^>]*>/g, ''))).replace(/\s+/g, ' ').trim();
    if (text) cues.push({ t: Number(m[1]) / 1000, text });
  }
  if (!cues.length) {
    for (const m of s.matchAll(/<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
      const text = decodeEntities(decodeEntities(m[2].replace(/<[^>]*>/g, ''))).replace(/\s+/g, ' ').trim();
      if (text) cues.push({ t: Number(m[1]), text });
    }
  }
  return cues;
}

const stamp = (sec) => {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};

// Cues -> `[m:ss] text` paragraphs of about `span` seconds.
function mergeCues(cues, span = 30) {
  const out = [];
  let cur = null;
  for (const c of cues) {
    if (cur && c.t - cur.t < span) cur.text += ` ${c.text}`;
    else { cur = { t: c.t, text: c.text }; out.push(cur); }
  }
  return out.map((p) => `[${stamp(p.t)}] ${p.text}`);
}

function formatYoutube({ id, oembed, details, transcript, trackLabel, transcriptNote }, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const d = details || {};
  const title = d.title || oembed?.title || `YouTube video ${id}`;
  const author = d.author || oembed?.author_name || '';
  const len = Number(d.lengthSeconds);
  const head = [`Source: youtube (${transcript ? 'transcript' : 'metadata'})`, `https://www.youtube.com/watch?v=${id}`,
    parts(author ? `Channel: ${author}` : '', len ? `Length: ${stamp(len)}` : '', d.viewCount ? `${fmtCount(Number(d.viewCount))} views` : '', d.isLiveContent ? 'live' : '')];
  const desc = d.shortDescription ? clip(d.shortDescription.trim(), Math.min(800, Math.floor(maxChars * 0.15))) : '';
  const top = [...head.filter(Boolean), ...(desc ? ['', 'Description:', desc] : [])].join('\n');
  let body;
  if (transcript && transcript.length) {
    const paras = mergeCues(transcript, 30);
    const room = Math.max(200, maxChars - top.length - 120);
    const lines = [];
    let used = 0;
    for (const p of paras) { if (used + p.length + 1 > room) break; lines.push(p); used += p.length + 1; }
    const cutAt = paras.length > lines.length ? paras[lines.length].match(/^\[([^\]]+)\]/)[1] : '';
    body = `\nTranscript (${trackLabel || 'captions'}):\n${lines.join('\n')}${cutAt ? `\n[transcript continues from ${cutAt}; not shown (size limit)]` : ''}`;
  } else {
    body = `\n${transcriptNote || 'No captions available; transcript not fabricated.'}`;
  }
  return { title, text: cap(`${top}\n${body}`, maxChars) };
}

async function ytTranscript(tracks, ctx) {
  const track = pickCaptionTrack(tracks, ctx.lang || 'en');
  if (!track?.baseUrl) return { none: true };
  const label = `${trackName(track)}${track.kind === 'asr' ? ', auto-generated' : ''}`;
  for (const suffix of ['&fmt=json3', '']) {
    try {
      const res = await ctx.get(track.baseUrl + suffix, { accept: '*/*' });
      const cues = res.ok ? parseTranscript(res.text) : [];
      if (cues.length) return { cues, label };
    } catch {}
  }
  return { withheld: true, label };
}

const youtubeExtractor = {
  name: 'youtube',
  matches: (url) => Boolean(ytId(url)),
  async read(url, ctx) {
    const id = ytId(url);
    if (!id) return null;
    const watchUrl = `https://www.youtube.com/watch?v=${id}`;
    const [oeRes, pageRes] = await Promise.allSettled([
      ctx.get(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`, { accept: 'application/json' }),
      ctx.get(watchUrl, { accept: 'text/html', headers: { 'accept-language': 'en-US,en;q=0.9' } }),
    ]);
    let oembed = null;
    try { if (oeRes.value?.ok) oembed = JSON.parse(oeRes.value.text); } catch {}
    let player = pageRes.value?.ok ? jsonAfter(pageRes.value.text, 'ytInitialPlayerResponse') : null;
    let tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    let t = tracks?.length ? await ytTranscript(tracks, ctx) : { none: true };
    if (!t.cues) { // the watch page's caption links are often empty for non-browser clients: ask the app player API
      try {
        const res = await ctx.get('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
          method: 'POST', accept: 'application/json', headers: { 'content-type': 'application/json', 'user-agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip' },
          body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, hl: 'en' } }, videoId: id }),
        });
        const j = res.ok ? JSON.parse(res.text) : null;
        if (j && j.videoDetails) player = { ...player, videoDetails: player?.videoDetails || j.videoDetails, playabilityStatus: player?.playabilityStatus || j.playabilityStatus };
        const apiTracks = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (apiTracks?.length) { tracks = apiTracks; t = await ytTranscript(apiTracks, ctx); }
      } catch {}
    }
    const details = player?.videoDetails;
    if (!details && !oembed) return null;
    const bad = player?.playabilityStatus?.status;
    const note = bad && bad !== 'OK' ? `This video is not playable signed out (${bad.toLowerCase()}${player.playabilityStatus.reason ? `: ${player.playabilityStatus.reason}` : ''}); transcript not fabricated.`
      : t.withheld ? 'Captions exist but YouTube would not release them to this request; transcript not fabricated.' : 'No captions available; transcript not fabricated.';
    return formatYoutube({ id, oembed, details, transcript: t.cues, trackLabel: t.label, transcriptNote: note }, { maxChars: ctx.maxChars });
  },
};

// ---------- X / Twitter ----------

function xStatusId(url) {
  const u = parseUrl(url);
  if (!u || !['x.com', 'twitter.com', 'mobile.twitter.com', 'fxtwitter.com', 'vxtwitter.com'].includes(bareHost(u))) return null;
  const m = /^\/(?:[\w]{1,15}|i\/web)\/status(?:es)?\/(\d{1,20})(?:\/|$)/.exec(u.pathname);
  return m ? m[1] : null;
}

// react-tweet's token for cdn.syndication.twimg.com/tweet-result
const xToken = (id) => ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');

function xText(t) {
  let text = t.text || '';
  const range = Array.isArray(t.display_text_range) ? t.display_text_range : null;
  if (range) text = Array.from(text).slice(range[0], range[1]).join('');
  for (const e of t.entities?.urls || []) if (e.url && e.expanded_url) text = text.split(e.url).join(e.expanded_url);
  for (const e of t.entities?.media || []) if (e.url) text = text.split(e.url).join('');
  return decodeEntities(text).replace(/[ \t]+\n/g, '\n').trim();
}

function xBlock(t, now) {
  const u = t.user || {};
  const lines = [parts(`@${u.screen_name || '?'}${u.name ? ` (${u.name})` : ''}`, t.created_at ? `${ago(t.created_at, now)} ago (${t.created_at.slice(0, 10)})` : '', t.favorite_count != null ? `${fmtCount(t.favorite_count)} likes` : '', t.conversation_count != null ? `${fmtCount(t.conversation_count)} replies` : ''), xText(t)];
  const media = [];
  for (const m of t.mediaDetails || []) {
    if (m.type === 'photo') media.push(`photo ${m.media_url_https}${m.ext_alt_text ? ` (alt: ${m.ext_alt_text})` : ''}`);
    else {
      const best = (m.video_info?.variants || []).filter((v) => v.content_type === 'video/mp4').sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      media.push(`${m.type} ${best?.url || m.media_url_https}`);
    }
  }
  if (!media.length) for (const p of t.photos || []) media.push(`photo ${p.url}`);
  if (media.length) lines.push(`Media: ${media.join('; ')}`);
  if (t.card?.binding_values?.title?.string_value) lines.push(`Card: ${t.card.binding_values.title.string_value}`);
  return lines;
}

function formatTweet(t, { maxChars = DEFAULT_MAX_CHARS, now = Date.now() } = {}) {
  if (!t || t.__typename === 'TweetTombstone') return { title: 'Post', text: 'Source: x (syndication)\nThis post is unavailable (deleted, protected or age-restricted).' };
  const out = ['Source: x (syndication)', ...(t.parent ? ['In reply to:', ...xBlock(t.parent, now).map((l) => `> ${l}`), ''] : []), ...xBlock(t, now)];
  if (t.quoted_tweet) out.push('Quoting:', ...xBlock(t.quoted_tweet, now).map((l) => `> ${l}`));
  return { title: `Post by @${t.user?.screen_name || '?'}`, text: cap(out.join('\n'), maxChars) };
}

const xExtractor = {
  name: 'x',
  matches: (url) => Boolean(xStatusId(url)),
  async read(url, ctx) {
    const id = xStatusId(url);
    if (!id) return null;
    try {
      const res = await ctx.get(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${xToken(id)}`, { accept: 'application/json' });
      if (res.ok) {
        const t = JSON.parse(res.text);
        if (t && (t.id_str || t.__typename === 'TweetTombstone')) return formatTweet(t, { maxChars: ctx.maxChars, now: ctx.now() });
      }
    } catch {}
    const res = await ctx.get(`https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://twitter.com/i/status/${id}`)}&omit_script=1`, { accept: 'application/json' });
    if (!res.ok) return null;
    const j = JSON.parse(res.text);
    const html = String(j.html || '');
    const body = htmlToText(/<p\b[\s\S]*?<\/p>/i.exec(html)?.[0] || '');
    if (!body) return null;
    const tail = />\s*(?:&mdash;|—)\s*([^<]+)/.exec(html)?.[1] || '';
    return { title: `Post by ${j.author_name || '?'}`, text: cap(`Source: x (oembed)\n${j.author_name ? `@${String(j.author_url || '').split('/').pop() || j.author_name} (${j.author_name})` : ''}${tail ? ` · ${decodeEntities(tail).trim()}` : ''}\n${body}`, ctx.maxChars) };
  },
};

// ---------- TikTok ----------

function tiktokTarget(url) {
  const u = parseUrl(url);
  if (!u || !['tiktok.com', 'm.tiktok.com'].includes(bareHost(u))) return null;
  return /^\/@[\w.-]+\/(?:video|photo)\/\d+/.test(u.pathname) ? { canonical: `https://www.tiktok.com${u.pathname.replace(/\/$/, '')}` } : null;
}

function formatTikTok(m, { maxChars = DEFAULT_MAX_CHARS, now = Date.now() } = {}, how = 'oembed') {
  const stats = m.stats || {};
  const out = [`Source: tiktok (${how})`, parts(m.author ? `@${m.author}` : '', m.nickname ? `(${m.nickname})` : '', m.ts ? `${ago(m.ts, now)} ago` : ''),
    parts(stats.playCount != null ? `${fmtCount(stats.playCount)} plays` : '', stats.diggCount != null ? `${fmtCount(stats.diggCount)} likes` : '', stats.commentCount != null ? `${fmtCount(stats.commentCount)} comments` : '', stats.shareCount != null ? `${fmtCount(stats.shareCount)} shares` : ''),
    m.text || '(no caption)', m.music ? `Sound: ${m.music}` : ''];
  return { title: clip(m.text || `TikTok by @${m.author || '?'}`, 100), text: cap(out.filter(Boolean).join('\n'), maxChars) };
}

// In the page: the rehydration JSON (isolated world can read the script tag text).
function tiktokPageProbe(doc) {
  const el = doc.querySelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__');
  if (!el) return null;
  try {
    const item = JSON.parse(el.textContent)?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
    if (!item) return null;
    return { desc: item.desc, author: item.author?.uniqueId, nickname: item.author?.nickname, stats: item.stats, createTime: item.createTime, music: item.music?.title, id: item.id };
  } catch { return null; }
}

function formatTikTokPage(raw, { maxChars = DEFAULT_MAX_CHARS, now = Date.now() } = {}) {
  if (!raw || (!raw.desc && !raw.author)) return null;
  return formatTikTok({ text: raw.desc, author: raw.author, nickname: raw.nickname, stats: raw.stats, ts: raw.createTime ? Number(raw.createTime) * 1000 : null, music: raw.music }, { maxChars, now }, 'page');
}

const tiktokExtractor = {
  name: 'tiktok',
  matches: (url) => Boolean(tiktokTarget(url)),
  async read(url, ctx) {
    const t = tiktokTarget(url);
    if (!t) return null;
    const res = await ctx.get(`https://www.tiktok.com/oembed?url=${encodeURIComponent(t.canonical)}`, { accept: 'application/json' });
    if (!res.ok) return null;
    const j = JSON.parse(res.text);
    if (!j || !(j.title || j.author_name)) return null;
    return formatTikTok({ text: j.title, author: String(j.author_url || '').split('@').pop() || '', nickname: j.author_name }, { maxChars: ctx.maxChars, now: ctx.now() });
  },
};

// ---------- GitHub ----------

const GH_RESERVED = new Set(['orgs', 'settings', 'topics', 'marketplace', 'features', 'sponsors', 'explore', 'notifications', 'login', 'join', 'about', 'pricing', 'collections', 'trending', 'search', 'new', 'apps', 'enterprise', 'security', 'codespaces', 'pulls', 'issues', 'users', 'site', 'readme', 'customer-stories', 'solutions', 'resources', 'sessions', 'account', 'dashboard', 'organizations', 'copilot', 'models', 'stars', 'watching', 'contact', 'git-guides', 'events', 'premium-support']);

function githubTarget(url) {
  const u = parseUrl(url);
  if (!u || !['github.com', 'www.github.com'].includes(u.hostname.toLowerCase())) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg.length < 2 || GH_RESERVED.has(seg[0].toLowerCase()) || !/^[\w.-]+$/.test(seg[0]) || !/^[\w.-]+$/.test(seg[1])) return null;
  const [owner, repo] = seg;
  if (seg.length === 2) return { kind: 'repo', owner, repo };
  if ((seg[2] === 'issues' || seg[2] === 'pull') && /^\d+$/.test(seg[3] || '') && seg.length <= 5) return { kind: seg[2] === 'pull' ? 'pr' : 'issue', owner, repo, n: seg[3] };
  return null;
}

function formatGithubRepo(r, readme, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const top = ['Source: github (api)', `${r.full_name}${r.archived ? ' (archived)' : ''}${r.fork ? ' (fork)' : ''}`, r.description || '',
    parts(r.language || '', r.stargazers_count != null ? `${fmtCount(r.stargazers_count)} stars` : '', r.forks_count != null ? `${fmtCount(r.forks_count)} forks` : '', r.open_issues_count != null ? `${fmtCount(r.open_issues_count)} open issues` : '', r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : '', r.pushed_at ? `pushed ${ago(r.pushed_at)} ago` : ''),
    r.homepage ? `Homepage: ${r.homepage}` : '', (r.topics || []).length ? `Topics: ${r.topics.join(', ')}` : ''].filter(Boolean).join('\n');
  const cleaned = (readme || '').replace(/\r/g, '').split('\n').filter((l) => !/^\s*(\[?!\[|<img\b|<p align)/i.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const body = cleaned ? `\n\nREADME:\n${clip(cleaned, Math.max(300, maxChars - top.length - 40))}` : '';
  return { title: r.full_name, text: cap(top + body, maxChars) };
}

function formatGithubIssue(i, comments, pr, { maxChars = DEFAULT_MAX_CHARS, now = Date.now() } = {}) {
  const isPr = Boolean(i.pull_request);
  const state = isPr && pr?.merged ? 'merged' : i.state;
  const head = ['Source: github (api)', `${isPr ? 'PR' : 'Issue'} #${i.number}: ${i.title}`, parts(state, i.user ? `by ${i.user.login}` : '', i.created_at ? `${ago(i.created_at, now)} ago` : '', `${fmtCount(i.comments)} comments`, (i.labels || []).length ? `labels: ${i.labels.map((l) => l.name || l).join(', ')}` : '', i.assignees?.length ? `assigned: ${i.assignees.map((a) => a.login).join(', ')}` : '', i.locked ? 'locked' : ''),
    pr ? parts(pr.head?.ref && pr.base?.ref ? `${pr.head.ref} -> ${pr.base.ref}` : '', pr.changed_files != null ? `${pr.changed_files} files` : '', pr.additions != null ? `+${pr.additions}/-${pr.deletions}` : '', pr.draft ? 'draft' : '') : ''].filter(Boolean);
  const text = i.body ? clip(i.body.replace(/\r/g, '').trim(), Math.min(4000, Math.floor(maxChars * 0.5))) : '';
  const top = [...head, ...(text ? ['', text] : [])].join('\n');
  const items = (comments || []).map((c) => ({ depth: 0, author: c.user?.login, ts: c.created_at, text: (c.body || '').replace(/\r/g, ''), flags: c.user?.login === i.user?.login ? ['OP'] : [], score: null }));
  const { lines, omitted } = renderComments(items, Math.max(300, maxChars - top.length - 100), { prefix: '', now });
  return { title: `${isPr ? 'PR' : 'Issue'} #${i.number}: ${i.title}`, text: cap(`${top}\n${items.length ? `\nComments (${lines.length} of ${items.length}):\n${lines.join('\n')}${omitted ? `\n[${omitted}]` : ''}` : '\n(No comments.)'}`, maxChars) };
}

const githubExtractor = {
  name: 'github',
  matches: (url) => Boolean(githubTarget(url)),
  async read(url, ctx) {
    const t = githubTarget(url);
    if (!t) return null;
    const api = (p, accept = 'application/vnd.github+json') => ctx.get(`https://api.github.com/repos/${t.owner}/${t.repo}${p}`, { accept });
    const opts = { maxChars: ctx.maxChars, now: ctx.now() };
    if (t.kind === 'repo') {
      const [r, rd] = await Promise.all([api(''), api('/readme', 'application/vnd.github.raw').catch(() => null)]);
      if (!r.ok) return null; // 403 (rate limit), 404: the page read
      return formatGithubRepo(JSON.parse(r.text), rd?.ok ? rd.text : '', opts);
    }
    const [i, c, p] = await Promise.all([api(`/issues/${t.n}`), api(`/issues/${t.n}/comments?per_page=100`).catch(() => null), t.kind === 'pr' ? api(`/pulls/${t.n}`).catch(() => null) : null]);
    if (!i.ok) return null;
    return formatGithubIssue(JSON.parse(i.text), c?.ok ? JSON.parse(c.text) : [], p?.ok ? JSON.parse(p.text) : null, opts);
  },
};

// ---------- registry and runners ----------

redditExtractor.inPage = `(${redditPageProbe})(document)`;
redditExtractor.formatPage = formatRedditPage;
tiktokExtractor.inPage = `(${tiktokPageProbe})(document)`;
tiktokExtractor.formatPage = formatTikTokPage;

const EXTRACTORS = [redditExtractor, hnExtractor, youtubeExtractor, xExtractor, tiktokExtractor, githubExtractor];
const extractorFor = (url) => EXTRACTORS.find((e) => e.matches(url)) || null;

// A GET/POST helper over any fetch-like function (Electron's session.fetch on the cookie-less partition): desktop
// Chrome user agent, 10 s timeout, no cookies, and a redirect off the known sites is a failure.
function makeGet(fetchFn) {
  return async function get(url, { accept = '*/*', method = 'GET', body, headers = {} } = {}) {
    const res = await fetchFn(url, { method, body, headers: { 'user-agent': UA, accept, ...headers }, credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    let host = '';
    try { host = new URL(res.url || url).hostname.toLowerCase(); } catch {}
    if (host && !hostAllowed(host)) return { ok: false, status: 0, text: '', url: res.url };
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: text.length > 4_000_000 ? text.slice(0, 4_000_000) : text, url: res.url || url };
  };
}

const finish = (r, source, maxChars) => {
  if (!r || typeof r.text !== 'string' || !r.text.trim()) return null;
  return { title: String(r.title || ''), text: cap(r.text, maxChars), source: source.name };
};

// Network read. null when the address isn't supported or anything went wrong: the caller does its normal read.
async function readSite(url, { get, maxChars = DEFAULT_MAX_CHARS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, lang = 'en' } = {}) {
  const ex = extractorFor(url);
  if (!ex || typeof get !== 'function') return null;
  try {
    return finish(await ex.read(url, { get, maxChars, sleep, now, lang }), ex, maxChars);
  } catch {
    return null;
  }
}

// From a loaded page: `run(script)` evaluates in the page (an isolated world) and returns the value.
async function readSiteInPage(url, run, { maxChars = DEFAULT_MAX_CHARS, now = Date.now } = {}) {
  const ex = extractorFor(url);
  if (!ex || !ex.inPage || typeof run !== 'function') return null;
  try {
    return finish(ex.formatPage(await run(ex.inPage), { maxChars, now: now(), url }), ex, maxChars);
  } catch {
    return null;
  }
}

module.exports = {
  extractorFor, readSite, readSiteInPage, makeGet, DEFAULT_MAX_CHARS, UA,
  // exported for tests
  redditTarget, parseRedditJson, parseRedditRss, formatRedditThread, formatRedditPage, redditPageProbe, redditRequests,
  hnTarget, formatHnItem, formatHnList, ytId, jsonAfter, pickCaptionTrack, parseTranscript, mergeCues, formatYoutube,
  xStatusId, xToken, formatTweet, tiktokTarget, tiktokPageProbe, formatTikTokPage, githubTarget, formatGithubRepo, formatGithubIssue,
  renderComments, htmlToText, fmtCount, ago,
};
