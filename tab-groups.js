// Tab groups: the model, automatic grouping rules, and site names. main.js owns the tabs; this
// module works on the same array through the accessors passed to createTabGroups().
const { getDomain } = require('tldts-experimental');

const GROUP_COLORS = ['blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'gray'];

const KNOWN_SITES = {
  youtube: 'YouTube', github: 'GitHub', wikipedia: 'Wikipedia', google: 'Google', reddit: 'Reddit',
  amazon: 'Amazon', stackoverflow: 'Stack Overflow', stackexchange: 'Stack Exchange', twitter: 'X', x: 'X',
  linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', nytimes: 'NYT', bbc: 'BBC',
  medium: 'Medium', notion: 'Notion', figma: 'Figma', netflix: 'Netflix', spotify: 'Spotify',
  duckduckgo: 'DuckDuckGo', bing: 'Bing', apple: 'Apple', microsoft: 'Microsoft', mozilla: 'Mozilla',
  ycombinator: 'Hacker News', npmjs: 'npm', anthropic: 'Anthropic', openai: 'OpenAI', claude: 'Claude',
};

function hostname(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

// "en.wikipedia.org" -> "wikipedia.org", "news.bbc.co.uk" -> "bbc.co.uk", IPs stay as they are.
// From the Public Suffix List, private section included: every "*.github.io", "*.vercel.app" or
// "*.netlify.app" site is someone else's, so "a.github.io" and "b.github.io" are two sites.
function registrableDomain(url) {
  const host = hostname(url);
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host;
  return getDomain(host, { allowPrivateDomains: true }) || host;
}

// Apps that share one company domain but are different things to the user: Gmail and Docs are
// both google.com, and grouping them together as "Google" helped no one.
const PRODUCT_SITES = {
  'mail.google.com': 'Gmail', 'docs.google.com': 'Google Docs', 'drive.google.com': 'Google Drive',
  'calendar.google.com': 'Google Calendar', 'meet.google.com': 'Google Meet', 'maps.google.com': 'Google Maps',
  'photos.google.com': 'Google Photos', 'keep.google.com': 'Google Keep', 'news.google.com': 'Google News',
  'translate.google.com': 'Google Translate', 'scholar.google.com': 'Google Scholar', 'classroom.google.com': 'Classroom',
  'music.youtube.com': 'YouTube Music', 'studio.youtube.com': 'YouTube Studio',
  'outlook.live.com': 'Outlook', 'outlook.office.com': 'Outlook', 'teams.microsoft.com': 'Teams', 'onedrive.live.com': 'OneDrive',
};

// What "the same site" means when grouping by site: the registrable domain, except that each app
// above counts as a site of its own.
function siteKey(url) {
  const host = hostname(url);
  return PRODUCT_SITES[host] ? host : registrableDomain(url);
}

// A short human name for a site: known names first, then a page-title suffix that matches the
// domain ("Title - Wikipedia"), then the capitalised domain label.
function siteName(url, title = '') {
  const product = PRODUCT_SITES[hostname(url)];
  if (product) return product;
  const domain = registrableDomain(url);
  const label = domain.split('.')[0] || domain;
  if (KNOWN_SITES[label]) return KNOWN_SITES[label];
  const suffix = String(title).split(/\s+[-|–—·:]\s+/).pop()?.trim();
  if (suffix && suffix !== title && suffix.length <= 24 && suffix.split(/\s+/).length <= 3) {
    const compact = suffix.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (compact && (compact.includes(label) || label.includes(compact))) return suffix;
  }
  if (/^[\d.]+$/.test(label)) return domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Search engines' own pages never form a group.
const SEARCH_DOMAINS = new Set(['google.com', 'duckduckgo.com', 'bing.com', 'search.brave.com', 'brave.com', 'ecosia.org', 'startpage.com', 'yahoo.com', 'baidu.com', 'yandex.com', 'yandex.ru']);
// A search engine's page or one of the well-known apps (Gmail, Drive ...): never worth asking a model about.
const isAppOrSearch = (url) => Boolean(PRODUCT_SITES[hostname(url)]) || SEARCH_DOMAINS.has(registrableDomain(url));

// ---------- topics: local, private clustering of tabs by title, site and address ----------
//
// TF-IDF over each tab's words (title, site name, address path, search query) with cosine
// similarity and average-linkage clustering. Words only one tab has can't link two tabs, and
// words most tabs share say nothing, so both are dropped before comparing; unrelated tabs stay
// loose.

const STOPWORDS = new Set(`a an and are as at be by for from has have how i in is it its of on or our that the this to was what when where which who why will with you your
about after all also any best can com could do does get go guide home into just like login more most new news no not now official one only other out over page
said see sign site so some than them then there these they top up us use using via vs was way we web welcome were what www html htm php aspx index amp http https
official free online app video videos watch search results result edit view log docs doc wiki org net io co uk en de fr es de
help helps works time times visit deal deals thing things day days week weeks year years review reviews reviewed rated tips ideas
library libraries open source powerful comprehensive community resources ecosystem platform
// Function words of the languages most tab titles come in besides English (French, Spanish, German, Portuguese):
// without them "7 jours" and "3 jours" link a weather page to a Paris itinerary.
le la les des du un une et en pour que qui dans sur avec voir jour jours par au aux pas plus est sont ce cette
el los las del una por para con como que mas dias dia paso donde libre gratis
der die das und ein eine mit von zu für auf ist im den dem
de da do dos das os um uma com para por mais`.split(/\s+/));
const TOPIC_THRESHOLD = 0.34;
// Small pools (2-3 loose tabs) need stronger evidence than a full cluster does before forming a
// group: fewer members corroborating the same words makes an incidental overlap more likely.
const LOOSE_PAIR_THRESHOLD = 0.5;
// After the first pass, merge already-pure sub-clusters whose pooled vocabulary (centroid) is
// close: the cross-site topic signal (esp. from page text) often only shows up once each side's
// words are pooled, even when no single pair of tabs was similar enough on its own.
const CENTROID_MERGE_THRESHOLD = 0.3;
// A word nearly every tab of ONE site has (a nav label, "flights"/"hotel deals" boilerplate) is
// that site's template, not a topic - it shouldn't count when linking two tabs of that same site.
const SITE_TEMPLATE_RATIO = 0.7;
const SITE_TEMPLATE_PENALTY = 0.15;
const MAX_GROUP = 12; // a bigger cluster is split again, more strictly
const TEXT_WEIGHT = 0.7; // page text (meta description/h1): more deliberate than a URL path, less than the title
const BIGRAM_VEC_WEIGHT = 0.5; // a 2-word combination is more specific than either word alone

// Brand names (site labels) are never a topic on their own: "youtube"/"reddit" etc.
const BRAND_WORDS = new Set(Object.entries(KNOWN_SITES).flatMap(([k, v]) => [k, v.toLowerCase().replace(/[^a-z0-9]/g, '')]));

// Light Porter-style stemming: plurals, then -ing/-ed/-er with a doubled-consonant collapse
// ("running" -> "runn" -> "run"). Approximate on purpose - only used as a matching key, never shown.
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  let s = w;
  if (s.length > 5 && s.endsWith('ing') && /[aeiou]/.test(s.slice(0, -3))) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed') && /[aeiou]/.test(s.slice(0, -2))) s = s.slice(0, -2);
  else if (s.length > 5 && s.endsWith('er') && /[aeiou]/.test(s.slice(0, -2))) s = s.slice(0, -2);
  if (s.length > 3 && /(.)\1$/.test(s) && !/(ss|ll|ff|zz)$/.test(s)) s = s.slice(0, -1);
  if (s.length > 3 && /[^s]s$/.test(s)) s = s.slice(0, -1);
  return s;
}

// A title that says nothing about the page: it is still loading, behind a bot check, or a login wall.
// Its address words describe the tab instead, so it can still join the tabs it leads to.
const TRANSIENT_TITLE = /^\s*(loading|please wait|just a moment|one moment|redirecting|attention required|access denied|checking your browser|untitled|about:blank|new tab|connecting|sign[ -]?in|log[ -]?in|sign[ -]?up|login|register|authenticating|verifying)(?![\p{L}\p{N}])/iu;
function isTransientTitle(title) {
  const t = String(title || '').trim();
  return !t || TRANSIENT_TITLE.test(t) || /^https?:\/\//i.test(t);
}

// Strip a leading/trailing " - YouTube" / " | Reddit" / " — Stack Overflow" style segment that
// just names the site: it's brand noise, not topic, and left in it clusters same-site tabs together.
function stripSiteSegment(title, url) {
  const parts = String(title).split(/\s+[-|–—·:]\s+/);
  if (parts.length < 2) return title;
  const label = registrableDomain(url).split('.')[0];
  const matches = (seg) => {
    const compact = seg.toLowerCase().replace(/[^a-z0-9]/g, '');
    return compact.length > 1 && (compact === label || BRAND_WORDS.has(compact) || (label && (compact.includes(label) || label.includes(compact))));
  };
  if (matches(parts[parts.length - 1])) return parts.slice(0, -1).join(' - ');
  if (matches(parts[0])) return parts.slice(1).join(' - ');
  return title;
}

// A search box's own query ("q=", "search=", ...): strong topic signal, e.g. google.com/search?q=...
function queryText(url) {
  try {
    const { searchParams } = new URL(url);
    for (const k of ['q', 'query', 'search', 'text', 'p']) { const v = searchParams.get(k); if (v) return v; }
  } catch {}
  return '';
}

// Character trigrams of a short title: titles too short to share whole words (e.g. "iPhone 15" vs
// "iPhone 16 Review") can still overlap on substrings. Only used to help sparse documents.
function charTrigrams(text) {
  const grams = [];
  for (const word of text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')) {
    if (word.length < 4 || /^\d+$/.test(word) || STOPWORDS.has(word)) continue; // no year/number noise
    for (let i = 0; i <= word.length - 3; i++) grams.push(`#${word.slice(i, i + 3)}`);
  }
  return grams;
}

// Informative tokens of a text, in order, with stem key + original surface (for naming/bigrams).
function tokens(text) {
  const out = [];
  for (const raw of String(text).split(/[^\p{L}\p{N}]+/u)) {
    const w = raw.toLowerCase();
    if (w.length < 3 || /^\d+$/.test(w) || STOPWORDS.has(w)) continue;
    out.push({ key: stem(w), surface: raw });
  }
  return out;
}

// Words of one tab: stem -> { weight, surface (first seen, for naming) }. Also carries
// `.bigrams`: adjacent word pairs from the title/query, for naming a cluster "Machine Learning"
// rather than two unrelated top words.
// Code hosts: "owner/repo" identifies a project, so its issues, PRs, discussions and code pages
// belong together, and (with the repo name as a word) with the docs and questions about it.
const REPO_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);
const NOT_AN_OWNER = new Set(['orgs', 'settings', 'marketplace', 'topics', 'search', 'notifications', 'pulls', 'issues', 'explore', 'sponsors', 'features', 'login', 'new', 'about', 'pricing', 'collections', 'trending', 'users', 'apps']);
function repoOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!REPO_HOSTS.has(host)) return null;
    const [owner, repo] = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase());
    if (!owner || !repo || NOT_AN_OWNER.has(owner)) return null;
    return { key: `@${host}/${owner}/${repo}`, name: repo, owner };
  } catch { return null; }
}

// "issues", "pull", "discussions" ... -> what kind of page a repo tab is (for naming "Lumen PRs").
function repoPageKind(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean)[2] || '';
    if (/^pulls?$/.test(seg)) return 'PRs';
    if (seg === 'issues') return 'issues';
    if (seg === 'discussions') return 'discussions';
  } catch {}
  return '';
}

function tabWords({ title = '', url = '', text = '', hint = '' }) {
  const words = new Map();
  const bigrams = [];
  const add = (list, weight, { naming = false, vector = false } = {}) => {
    for (let i = 0; i < list.length; i++) {
      const { key, surface } = list[i];
      const entry = words.get(key) || { weight: 0, surface };
      entry.weight = Math.max(entry.weight, weight);
      words.set(key, entry);
      // Naming bigrams are for a display name ("Machine Learning"): only from natural-language
      // text (title, search query), never the URL path - "docs/framework/react" isn't a phrase.
      if (naming && i > 0) bigrams.push({ key: `${list[i - 1].key}|${key}`, surface: `${list[i - 1].surface} ${surface}` });
      // Vector bigrams are a similarity feature, not shown: a specific 2-word combination
      // ("noise cancelling") is a stronger topic signal than either word counted alone, and
      // helps page text where adjacency survives stopword-stripping less cleanly than in titles.
      if (vector && i > 0) {
        const bkey = `~${list[i - 1].key}|${key}`;
        const bentry = words.get(bkey) || { weight: 0, surface: bkey };
        bentry.weight = Math.max(bentry.weight, BIGRAM_VEC_WEIGHT);
        words.set(bkey, bentry);
      }
    }
  };
  const cleanTitle = isTransientTitle(title) ? '' : stripSiteSegment(title, url);
  const titleTokens = tokens(cleanTitle);
  add(titleTokens, 1, { naming: true, vector: true });
  let pathname = '';
  try { ({ pathname } = new URL(url)); } catch {}
  const domain = registrableDomain(url);
  const label = domain.split('.')[0] || domain;
  // Down-weighted: same-site tabs shouldn't cluster on the brand alone, only add real topic overlap.
  if (label && label.length >= 3 && !SEARCH_DOMAINS.has(domain)) add(tokens(label), 0.3);
  add(tokens(decodeURIComponent(pathname).replace(/[-_]/g, ' ')), 0.5);
  const q = queryText(url);
  if (q) add(tokens(decodeURIComponent(q.replace(/\+/g, ' '))), 1, { naming: true, vector: true });
  if (text) add(tokens(String(text).slice(0, 500)), TEXT_WEIGHT, { vector: true }); // optional page text (see main.js note)
  // The search a tab was opened from (main.js passes the opener's query): the page is what that search led to.
  if (hint) add(tokens(String(hint).slice(0, 200)), 0.8, { vector: true });
  const repo = repoOf(url);
  if (repo) {
    words.set(repo.key, { weight: 1.2, surface: repo.name });
    add(tokens(repo.name.replace(/[-_.]/g, ' ')), 0.8);
  }
  words.brand = label && label.length >= 4 && !BRAND_WORDS.has(label) && !SEARCH_DOMAINS.has(domain) ? label : '';
  if (titleTokens.length <= 2) for (const g of charTrigrams(cleanTitle)) if (!words.has(g)) words.set(g, { weight: 0.4, surface: g });
  words.bigrams = bigrams;
  return words;
}

// TF-IDF vectors for a set of entries, idf computed over just this set ("current tabs").
function vectorize(entries) {
  const docs = entries.map((e) => ({ ...e, words: tabWords(e), site: registrableDomain(e.url) }));
  const n = docs.length;
  // A site's own name ("nextjs.org", "zod.dev") is brand noise between two of its own pages, but
  // it IS the topic when a page of ANOTHER site names it (Stack Overflow "Next.js ...", a GitHub
  // repo called next.js): then the site's tabs get that word at full strength, so the docs join.
  for (const d of docs) {
    const b = d.words.brand;
    if (!b) continue;
    for (const variant of new Set([b, b.replace(/(js|hq|io|py|css|ui|dev|lang|cli)$/, '')])) {
      if (variant.length < 3) continue;
      const key = stem(variant);
      if (docs.some((o) => o.site !== d.site && (o.words.get(key)?.weight ?? 0) >= 0.8)) d.words.set(key, { weight: 1, surface: d.words.get(key)?.surface || variant.charAt(0).toUpperCase() + variant.slice(1) });
    }
  }
  const df = new Map();
  for (const d of docs) for (const key of d.words.keys()) df.set(key, (df.get(key) || 0) + 1);
  const informative = (key) => df.get(key) >= 2 && (n < 4 || df.get(key) / n <= 0.8);
  const idf = (key) => Math.log((n + 1) / (df.get(key) + 1)) + 1;
  for (const d of docs) {
    d.vec = new Map();
    for (const [key, { weight }] of d.words) if (informative(key)) d.vec.set(key, weight * idf(key));
    // A single shared dimension makes cosine similarity exactly 1 no matter how small its weight
    // is - two tabs whose only overlap is the low-weight site label (a "youtube"/"github" that
    // was the ONLY thing they had in common) would look like a perfect match. A solo word from
    // the title or a search query (weight 1) is a real, deliberate signal ("recipe", "tokyo") and
    // can stand alone; a solo word that only made it in at a lower weight (site label, URL path,
    // page text) can't - require a second dimension to corroborate it first.
    const [soleKey] = d.vec.keys();
    const soleOk = d.vec.size === 1 && d.words.get(soleKey).weight >= 1;
    d.norm = d.vec.size >= 2 || soleOk ? Math.hypot(...d.vec.values()) : 0;
  }
  // Same-site template words: a word nearly every sampled tab of ONE site has (nav labels,
  // "flights to X" / "hotel deals" boilerplate that just happens to repeat across the couple of
  // pages we grabbed from that site) isn't topic evidence - it shouldn't help two tabs of that
  // same site look alike. But a word that's ALSO informative outside that site (it showed up on
  // at least one other site too) is exactly the cross-site topic signal we want, even if by
  // chance every one of that site's own sampled tabs happens to share it too (e.g. two docs
  // pages from the same library's own site, both mentioning the library's name) - only penalize
  // a word that is exclusively confined to this one site in the current pool.
  const bySite = new Map();
  docs.forEach((d, i) => { if (!d.site) return; if (!bySite.has(d.site)) bySite.set(d.site, []); bySite.get(d.site).push(i); });
  for (const d of docs) d.template = new Set();
  for (const idxs of bySite.values()) {
    if (idxs.length < 2) continue;
    const count = new Map();
    for (const i of idxs) for (const k of docs[i].vec.keys()) count.set(k, (count.get(k) || 0) + 1);
    for (const [k, c] of count) if (!k.startsWith('@') && c / idxs.length >= SITE_TEMPLATE_RATIO && df.get(k) === c) for (const i of idxs) docs[i].template.add(k);
  }
  return docs;
}

function cosine(a, b) {
  if (!a.norm || !b.norm) return 0;
  const sameSite = Boolean(a.site) && a.site === b.site;
  let dot = 0;
  let sharedReal = 0; // shared dimensions NOT already discounted as same-site template noise
  let soleKey = null;
  for (const [k, v] of a.vec) if (b.vec.has(k)) {
    const templated = sameSite && a.template?.has(k);
    dot += v * b.vec.get(k) * (templated ? SITE_TEMPLATE_PENALTY : 1);
    if (!templated) { sharedReal++; soleKey = k; }
  }
  // Two otherwise-unrelated tabs whose only REAL overlap is one word: trust it only if that word
  // was strong (title/query weight) in both, same reasoning as the solo-dimension case above. A
  // template-discounted word doesn't count towards "real" overlap, so it can't pad the count and
  // sneak a second, coincidental word (two different senses of "machine", say) past this gate.
  if (sharedReal <= 1 && !((a.words?.get(soleKey)?.weight ?? 1) >= 1 && (b.words?.get(soleKey)?.weight ?? 1) >= 1)) return 0;
  return dot / (a.norm * b.norm);
}

// A group's centroid: the average of its members' vectors, comparable to a loose tab's vector.
function centroidOf(docs) {
  const vec = new Map();
  // A member's own same-site-template words get discounted here too, the same as in cosine():
  // without this, comparing a straggler tab to this pooled centroid loses the sameSite check
  // (a centroid isn't "on" any one site), and boilerplate the straggler shares with just ONE
  // member's site could leak it into the wrong cluster.
  for (const d of docs) for (const [k, v] of d.vec) {
    const scaled = (d.template?.has(k) ? SITE_TEMPLATE_PENALTY : 1) * v;
    vec.set(k, (vec.get(k) || 0) + scaled / docs.length);
  }
  return { vec, norm: Math.hypot(...vec.values()) };
}

// A library or product whose own site is in the cluster and whose name most of the cluster's tabs carry
// (its docs, a Stack Overflow question, its repo): the cluster is named for it, as its site writes it
// ("Tailwind CSS", "Zod"), rather than for the most frequent word or phrase.
const brandVariants = (b) => new Set([b, b.replace(/(js|hq|io|py|css|ui|dev|lang|cli)$/, '')]);
function libraryName(members, majority) {
  for (const d of members) {
    const b = (d.site || '').split('.')[0];
    if (!b || b.length < 3 || BRAND_WORDS.has(b) || SEARCH_DOMAINS.has(d.site)) continue;
    for (const variant of brandVariants(b)) {
      if (variant.length < 3) continue;
      const key = stem(variant);
      if (members.filter((m) => m.vec.has(key)).length >= majority && members.filter((m) => m.site === d.site).length >= 2) return siteName(d.url, d.title);
    }
  }
  return '';
}

// entries: [{ id, title, url }] -> [{ name, ids, key }] with 2+ tabs each (loose tabs left out).
function topicClusters(entries, { threshold = TOPIC_THRESHOLD } = {}) {
  const docs = vectorize(entries);
  const n = docs.length;
  if (n < 2) return [];
  const sim = docs.map((a) => docs.map((b) => cosine(a, b)));
  // Average-linkage agglomerative clustering, merging the closest pair while above the threshold.
  const link = (x, y) => { let s = 0; for (const i of x) for (const j of y) s += sim[i][j]; return s / (x.length * y.length); };
  const agglomerate = (indices, at) => {
    const out = indices.map((i) => [i]);
    for (;;) {
      let best = null;
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const s = link(out[i], out[j]);
          if (s >= at && (!best || s > best.s)) best = { i, j, s };
        }
      }
      if (!best) return out;
      out[best.i] = out[best.i].concat(out[best.j]);
      out.splice(best.j, 1);
    }
  };
  let clusters = agglomerate(docs.map((_d, i) => i), threshold);
  // Second stage: merge sub-clusters (or fold in a leftover single tab) whose pooled vocabulary
  // (centroid) is close. A centroid is a cleaner signal than any single member's vector, so a
  // cross-site topic (esp. carried by page text) that wasn't quite enough to link two individual
  // sparse tabs often clears the bar once each side's words are pooled. Two bare singletons never
  // merge here, though - that pairwise comparison is identical to pass one's and already had its
  // shot there; this stage is only for absorbing a straggler into (or joining) real evidence.
  let merged = clusters.map((c) => [...c]);
  for (;;) {
    let best = null;
    for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        if (merged[i].length < 2 && merged[j].length < 2) continue;
        const s = cosine(centroidOf(merged[i].map((k) => docs[k])), centroidOf(merged[j].map((k) => docs[k])));
        if (s >= CENTROID_MERGE_THRESHOLD && (!best || s > best.s)) best = { i, j, s };
      }
    }
    if (!best) break;
    merged[best.i] = merged[best.i].concat(merged[best.j]);
    merged.splice(best.j, 1);
  }
  // No mega-groups: a cluster past MAX_GROUP is re-split at a stricter threshold (a few times); tabs
  // that no longer belong with anyone stay loose rather than being forced into a group.
  const split = (c, at, depth) => (c.length <= MAX_GROUP || depth >= 4 ? [c] : agglomerate(c, at).flatMap((part) => (part.length < 2 ? [] : split(part, at + 0.1, depth + 1))));
  clusters = merged.flatMap((c) => split(c, threshold + 0.1, 0));
  // Deterministic order: tabs in the order given, groups by their first tab.
  clusters = clusters.map((c) => [...c].sort((x, y) => x - y)).sort((x, y) => x[0] - y[0]);
  const titleCase = (w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w);
  const titleCasePhrase = (s) => s.split(/\s+/).map(titleCase).join(' ');
  const clip = (s) => (s.length <= 24 ? s : (s.slice(0, 24).replace(/\s+\S*$/, '') || s.slice(0, 24)));
  return clusters.filter((c) => c.length >= 2).map((c) => {
    const members = c.map((i) => docs[i]);
    let pairSum = 0;
    for (let x = 0; x < c.length; x++) for (let y = x + 1; y < c.length; y++) pairSum += sim[c[x]][c[y]];
    const cohesion = pairSum / ((c.length * (c.length - 1)) / 2); // mean similarity of member pairs: how tight the group is
    const isReal = (k) => !/^[#~@]/.test(k); // trigram/vector-bigram/repo keys are similarity-only, never names
    // A word (or bigram) has to be a strict majority, not just "at least half": for a 2-member
    // cluster, "half" (ceil(2/2) = 1) would let a word only ONE member has name the pair.
    const majority = Math.floor(members.length / 2) + 1;
    // Single-word candidates: the strongest word most members actually share.
    const score = new Map();
    for (const d of members) for (const [k, v] of d.vec) if (isReal(k)) score.set(k, (score.get(k) || 0) + v);
    const ranked = [...score].filter(([k]) => members.filter((d) => d.vec.has(k)).length >= majority).sort((a, b) => b[1] - a[1]);
    const surface = (k) => members.find((d) => d.words.has(k)).words.get(k).surface;
    // Bigram candidates: an adjacent pair (from the title or a search query) both members' words
    // consider informative, seen in most members - "Machine Learning" beats picking two
    // unrelated top words.
    const bigramScore = new Map();
    for (const d of members) {
      const seen = new Set();
      for (const { key, surface: bsurface } of d.words.bigrams || []) {
        if (seen.has(key)) continue;
        seen.add(key);
        const [k1, k2] = key.split('|');
        const v1 = d.vec.get(k1), v2 = d.vec.get(k2);
        if (!v1 || !v2) continue;
        const e = bigramScore.get(key) || { score: 0, count: 0, surface: bsurface };
        e.score += v1 + v2;
        e.count++;
        bigramScore.set(key, e);
      }
    }
    const bigramRanked = [...bigramScore.values()].filter((e) => e.count >= majority).sort((a, b) => b.score - a.score);
    const top = ranked[0];
    const siteOnly = top && members.every((d) => registrableDomain(d.url) === registrableDomain(members[0].url)) && registrableDomain(members[0].url).startsWith(top[0]);
    // A project's tabs: named for the repo ("Lumen PRs", "Lumen issues"), whatever else is in the group.
    const repoCount = new Map();
    for (const d of members) { const r = repoOf(d.url); if (r) repoCount.set(r.name, (repoCount.get(r.name) || 0) + 1); }
    const [topRepo, topRepoCount] = [...repoCount].sort((a, b) => b[1] - a[1])[0] || [];
    let name;
    if (topRepo && topRepoCount >= 2 && topRepoCount >= members.length / 2) {
      const kinds = new Set(members.filter((d) => repoOf(d.url)?.name === topRepo).map((d) => repoPageKind(d.url)));
      const kind = kinds.size === 1 ? [...kinds][0] : '';
      name = `${titleCasePhrase(topRepo.replace(/[-_]+/g, ' '))}${kind ? ` ${kind}` : ''}`;
    } else if (siteOnly) name = siteName(members[0].url, members[0].title);
    else if (libraryName(members, majority)) name = libraryName(members, majority);
    else if (bigramRanked.length) name = titleCasePhrase(bigramRanked[0].surface);
    else if (top) name = titleCase(surface(top[0]));
    else name = siteName(members[0].url, members[0].title);
    // "Next" from "Next.js" titles: keep the suffix a library name is written with.
    const dotted = /^[A-Za-z]+$/.test(name) && members.find((d) => new RegExp(`\\b${name}\\.(js|ts|py|io)\\b`, 'i').test(d.title));
    if (dotted) name = `${name}${String(dotted.title).match(new RegExp(`\\b${name}(\\.(?:js|ts|py|io))\\b`, 'i'))[1]}`;
    return { name: clip(name), ids: members.map((d) => d.id), key: top?.[0] || null, cohesion };
  });
}

// ---------- incremental placement: where does ONE tab belong among the groups that already exist? ----------
//
// A tab that just loaded (or changed title or site) is scored against each group's pooled words,
// with the same signal as "Organize by topic". It joins the best group only above TOPIC_THRESHOLD,
// and a tab that is already in a group only moves to another one that fits clearly better (MOVE_MARGIN).
// Pure: no tab objects, just entries ({ id, title, url, text, hint }).
const MAX_AUTO_MOVES = 3; // automatic placements/moves per tab, so a tab whose title keeps changing settles
const MOVE_MARGIN = 0.15;
const SAME_SITE_BONUS = 0.12; // a group already holding pages of this site: the site itself is weak evidence

// items: [{ entry, current }] (current: the group id the tab is in now, or null).
// groupList: [{ id, domain, members: [entry] }]. background: other loose entries, only for idf.
// Returns an array parallel to items: the group id to put each tab in, or null to leave it as it is.
function placeTabs(items, groupList, { background = [], threshold = TOPIC_THRESHOLD, margin = MOVE_MARGIN, bonus = null } = {}) {
  if (!items.length || !groupList.length) return items.map(() => null);
  const byId = new Map();
  for (const e of [...items.map((i) => i.entry), ...groupList.flatMap((g) => g.members), ...background]) if (!byId.has(e.id)) byId.set(e.id, e);
  const list = [...byId.values()];
  const docs = vectorize(list);
  const doc = new Map(list.map((e, i) => [e.id, docs[i]]));
  const pooled = new Map();
  const centroidFor = (g, exceptId) => {
    const key = `${g.id}|${g.members.some((m) => m.id === exceptId) ? exceptId : ''}`;
    if (!pooled.has(key)) {
      const rest = g.members.filter((m) => m.id !== exceptId);
      pooled.set(key, rest.length ? { members: rest, centroid: centroidOf(rest.map((m) => doc.get(m.id))) } : null);
    }
    return pooled.get(key);
  };
  const scoreOf = (entry, g) => {
    const d = doc.get(entry.id);
    const pool = centroidFor(g, entry.id);
    if (!pool) return 0;
    if (g.domain && siteKey(entry.url) === g.domain) return 1; // a by-site group: its own site's tabs belong
    const s = cosine(d, pool.centroid);
    const sameSite = Boolean(d.site) && pool.members.some((m) => doc.get(m.id).site === d.site);
    // What the user taught (bonus): only tips a tab that already has SOME words in common with the group.
    const taught = bonus && s >= 0.05 ? bonus(entry, g) : 0;
    return s + (sameSite && s >= threshold * 0.6 ? SAME_SITE_BONUS : 0) + taught;
  };
  return items.map(({ entry, current }) => {
    let best = null;
    let cur = 0;
    for (const g of groupList) {
      const s = scoreOf(entry, g);
      if (g.id === current) cur = s;
      else if (s >= threshold && (!best || s > best.s || (s === best.s && g.id < best.id))) best = { id: g.id, s };
    }
    if (current != null && groupList.some((g) => g.id === current)) {
      if (!best || best.s < cur + margin) return null;
      return best.id;
    }
    return best ? best.id : null;
  });
}

// ---------- a model's proposal, made safe ----------

const MAX_AI_GROUPS = 8;
function cleanGroupName(name) {
  return String(name || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f<>"]/g, '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join(' ').slice(0, 30);
}

// [{ name, tab_ids }] from a model -> [{ name, ids }] using only ids in validIds, each in one group,
// 2+ tabs per group, at most MAX_AI_GROUPS groups (the biggest). Anything else (not an array, no
// usable group, one group swallowing almost every tab) is null: the caller uses the local organizer.
function sanitizeProposal(proposal, validIds) {
  if (!Array.isArray(proposal)) return null;
  const valid = validIds instanceof Set ? validIds : new Set(validIds);
  const used = new Set();
  const out = [];
  for (const g of proposal) {
    if (!g || typeof g !== 'object') continue;
    const name = cleanGroupName(g.name);
    const ids = [];
    for (const raw of Array.isArray(g.tab_ids) ? g.tab_ids : []) {
      const id = Number(raw);
      if (Number.isInteger(id) && valid.has(id) && !used.has(id) && !ids.includes(id)) ids.push(id);
    }
    if (!name || ids.length < 2) continue;
    ids.forEach((id) => used.add(id));
    out.push({ name, ids });
  }
  if (!out.length) return null;
  const kept = out.length > MAX_AI_GROUPS ? [...out].sort((a, b) => b.ids.length - a.ids.length).slice(0, MAX_AI_GROUPS).sort((a, b) => out.indexOf(a) - out.indexOf(b)) : out;
  if (valid.size >= 6 && kept.some((g) => g.ids.length > valid.size * 0.8)) return null;
  return kept;
}

// The words of a tab's address path worth telling a model: "docs/react/hooks" -> "docs react hooks".
// Never the query string or fragment, and nothing that looks like an id, hash or token.
function pathWords(url, max = 6) {
  let pathname = '';
  try { ({ pathname } = new URL(url)); } catch { return ''; }
  const words = [];
  for (const seg of pathname.split('/')) {
    let s = seg;
    try { s = decodeURIComponent(seg); } catch {}
    for (const w of s.split(/[^\p{L}]+/u)) {
      if (w.length >= 3 && w.length <= 20 && !/^[a-f]+$/i.test(w) && !STOPWORDS.has(w.toLowerCase())) words.push(w.toLowerCase());
    }
  }
  return [...new Set(words)].slice(0, max).join(' ');
}

// ---------- merging groups with similar names ----------

const NAME_FILLER = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'and', 'in', 'on', 'with', 'tabs', 'tab', 'pages', 'page', 'links', 'stuff', 'misc', 'other', 'things']);
// A word that says WHAT KIND of thing the tabs are ("Lumen PRs" vs "Lumen"): a qualifier that keeps two
// groups apart on names alone.
const NAME_KIND = new Set(['pr', 'prs', 'issue', 'doc', 'discussion', 'video', 'review', 'pull', 'request', 'news', 'tutorial']);

function nameTokens(name) {
  return String(name).replace(/\(\d+\)\s*$/, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !NAME_FILLER.has(w)).map(stem);
}

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// How alike two group names are: 'exact' (same words after case, punctuation, plural and "(2)"),
// 'contain' (one is the other plus plain words: "Flights" / "Flights to Tokyo"), 'close' (a typo apart),
// 'weak' (they share a real word), or null. "Java" and "JavaScript" are none of these.
function nameSimilarity(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return null;
  if ([...ta].sort().join(' ') === [...tb].sort().join(' ')) return 'exact';
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (small.length < big.length && small.every((w) => big.includes(w)) && small.some((w) => w.length >= 4) && big.filter((w) => !small.includes(w)).every((w) => !NAME_KIND.has(w))) return 'contain';
  const ja = ta.join('');
  const jb = tb.join('');
  const len = Math.min(ja.length, jb.length);
  if (len >= 5 && ja[0] === jb[0] && levenshtein(ja, jb) <= Math.max(1, Math.floor(len / 8))) return 'close';
  if (ta.some((w) => w.length >= 4 && tb.includes(w))) return 'weak';
  return null;
}

// groups: [{ id, name, color, auto, userNamed, domain, members: [entry] }] (the window's own groups).
// Returns the merges to make: [{ into, from: [ids], name, color, auto, userNamed }]. Deterministic: oldest
// group first, one pass (a merged group is not compared again), so merging can't ping-pong. By-site
// groups are left alone. Groups the user made or named only merge with an exact twin, and then the
// user's name and colour survive; otherwise the more specific name and the oldest group's colour do.
function mergeSimilarGroups(groups) {
  const list = groups.filter((g) => !g.domain && g.members.length).sort((a, b) => a.id - b.id);
  if (list.length < 2) return [];
  const docs = vectorize(list.flatMap((g) => g.members));
  const doc = new Map(docs.map((d) => [d.id, d]));
  const centroid = new Map(list.map((g) => [g.id, centroidOf(g.members.map((m) => doc.get(m.id)))]));
  const owned = (g) => !g.auto || g.userNamed;
  const clusters = [];
  for (const g of list) {
    const home = clusters.find((c) => {
      const root = c[0];
      const kind = nameSimilarity(root.name, g.name);
      if (!kind) return false;
      if (kind === 'exact') return true;
      if (owned(root) || owned(g)) return false;
      const sim = cosine(centroid.get(root.id), centroid.get(g.id));
      return kind === 'weak' ? sim >= CENTROID_MERGE_THRESHOLD : sim >= 0.1;
    });
    if (home) home.push(g); else clusters.push([g]);
  }
  return clusters.filter((c) => c.length > 1).map((c) => {
    const named = c.find((g) => g.userNamed);
    const specific = [...c].sort((a, b) => nameTokens(b.name).length - nameTokens(a.name).length || b.name.length - a.name.length || a.id - b.id)[0];
    const base = named || specific;
    return {
      into: c[0].id,
      from: c.slice(1).map((g) => g.id),
      name: base.name.replace(/\s*\(\d+\)\s*$/, '') || base.name,
      color: named ? named.color : c[0].color,
      auto: c.every((g) => g.auto),
      userNamed: c.some((g) => g.userNamed),
    };
  });
}

// mode(): 'off' | 'site' | 'topic' (automatic grouping).
function createTabGroups({ getTabs, setTabs, urlOf, titleOf, textOf, isWeb, mode, aiTopics, onChange, learned = null }) {
  const groups = new Map(); // id -> { id, name, color, collapsed, domain, topic, auto }
  const isAuto = () => mode() !== 'off';
  let undoState = null; // the tabs and groups from before the last "Organize"
  let autoUndo = null; // the tabs the last automatic by-topic placement moved, and where they were
  let undoSeq = 0;
  let nextId = 1;
  let colorIndex = 0;

  const tabById = (id) => getTabs().find((t) => t.id === id);
  const members = (groupId) => getTabs().filter((t) => t.groupId === groupId);

  // Grouped tabs stay together, at the position of the group's first tab.
  function arrange() {
    const out = [];
    const placed = new Set();
    for (const tab of getTabs()) {
      if (!tab.groupId) out.push(tab);
      else if (!placed.has(tab.groupId)) {
        placed.add(tab.groupId);
        out.push(...members(tab.groupId));
      }
    }
    setTabs(out);
  }

  function cleanup() {
    for (const id of groups.keys()) if (!members(id).length) groups.delete(id);
  }

  // "Docs" twice becomes "Docs" and "Docs (2)"
  function uniqueName(name, exceptId = null) {
    const taken = new Set([...groups.values()].filter((g) => g.id !== exceptId).map((g) => g.name.toLowerCase()));
    if (!taken.has(String(name).toLowerCase())) return name;
    for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`.toLowerCase())) return `${name} (${n})`;
  }

  // One merge pass over this window's groups (see mergeSimilarGroups). `moves`: an automatic pass's
  // record of where tabs were, so undoAuto can put them back. Returns how many groups went away and
  // the groups as they were before.
  function mergeSimilar(moves = null) {
    const plan = mergeSimilarGroups([...groups.values()].map((g) => ({ ...g, members: members(g.id).filter((t) => !pinned(t)).map(entry) })));
    const touched = [];
    let gone = 0;
    for (const { into, from, name, color, auto, userNamed } of plan) {
      const keep = groups.get(into);
      touched.push({ ...keep }, ...from.map((id) => ({ ...groups.get(id) })));
      for (const id of from) {
        for (const tab of members(id)) {
          if (pinned(tab)) continue;
          if (moves && !moves.has(tab.id)) moves.set(tab.id, id);
          tab.groupId = into;
        }
        groups.delete(id);
        gone++;
      }
      keep.name = uniqueName(name, keep.id).slice(0, 40);
      keep.color = color;
      keep.auto = auto;
      keep.userNamed = userNamed;
    }
    if (gone) { arrange(); cleanup(); }
    return { gone, touched };
  }

  const pinned = (t) => Boolean(t.pinned);
  const entry = (t) => ({ id: t.id, title: titleOf(t), url: urlOf(t), text: textOf ? textOf(t) : '', hint: t.openerQuery || '' });
  const keyOf = (t) => { const e = entry(t); return `${e.title}|${e.url}|${e.text.length}`; };

  function create(name, tabIds, { domain = null, color, topic = null, auto = false, cohesion } = {}) {
    const group = {
      id: nextId++,
      name: String(name || 'Group').slice(0, 40),
      color: GROUP_COLORS.includes(color) ? color : GROUP_COLORS[colorIndex++ % GROUP_COLORS.length],
      collapsed: false,
      domain,
      topic, // the shared word a topic group was formed on; later tabs with it join
      auto, // made by automatic grouping (can be re-organized); groups the user made never are
      ...(cohesion == null ? {} : { cohesion }), // how tight the cluster was when formed (0-1)
    };
    groups.set(group.id, group);
    for (const id of tabIds) {
      const tab = tabById(id);
      if (!tab) continue;
      tab.groupId = group.id;
      tab.userRemoved = false;
      if (auto) tab.autoKey = keyOf(tab);
      else tab.userPlaced = true; // put there by the user (or an agent asked by them): never moved automatically
    }
    cleanup();
    arrange();
    return group;
  }

  // `auto`: an automatic placement (an opener's group), not a choice the user made.
  function add(tabId, groupId, { auto = false } = {}) {
    const tab = tabById(tabId);
    if (!tab || !groups.has(groupId)) return false;
    tab.groupId = groupId;
    tab.userRemoved = false;
    if (!auto) tab.userPlaced = true;
    arrange();
    cleanup();
    return true;
  }

  // Leaving a group puts the tab right after the group; `byUser` stops auto-grouping from pulling it back.
  function remove(tabId, { byUser = false } = {}) {
    const tab = tabById(tabId);
    if (!tab || !tab.groupId) return false;
    const groupId = tab.groupId;
    tab.groupId = null;
    if (byUser) tab.userRemoved = true;
    const list = getTabs().filter((t) => t !== tab);
    const lastIndex = list.map((t) => t.groupId).lastIndexOf(groupId);
    list.splice(lastIndex + 1, 0, tab);
    setTabs(list);
    cleanup();
    return true;
  }

  function ungroupAll(groupId) {
    for (const tab of members(groupId)) tab.groupId = null;
    groups.delete(groupId);
  }

  // A tab opened from another tab joins the opener's group (a new one if the opener has none).
  function joinOpener(tab, opener) {
    if (!isAuto() || !opener) return;
    // A tab opened from a search results page carries that search's words: it is what the search led to.
    const from = urlOf(opener);
    if (SEARCH_DOMAINS.has(registrableDomain(from))) tab.openerQuery = queryText(from).slice(0, 200);
    // Opened tabs sit right after the opener (or its group), like Safari and Chrome.
    const list = getTabs().filter((t) => t !== tab);
    const at = opener.groupId ? list.map((t) => t.groupId).lastIndexOf(opener.groupId) : list.indexOf(opener);
    list.splice(at + 1, 0, tab);
    setTabs(list);
    // One link opened in a new tab is not a topic: it only joins a group the opener is already in
    // (and is looked at again once it has a title: see autoGroupTopics).
    if (!pinned(tab) && opener.groupId && groups.has(opener.groupId)) {
      add(tab.id, opener.groupId, { auto: true });
      tab.autoMoves = 1;
    }
  }

  // Tabs automatic grouping may move: ungrouped web tabs the user hasn't taken out of a group,
  // dragged into place or put into a group themselves. Pinned tabs never.
  const movable = (t) => !pinned(t) && !t.userRemoved && !t.userMoved && !t.userPlaced && isWeb(urlOf(t));
  const loose = () => getTabs().filter((t) => !t.groupId && movable(t));

  // By topic, continuously: each tab whose title, address or page text changed (or that has no group)
  // is scored against every automatic group - topic groups and by-site groups alike - and joins, or
  // moves to, the best one it clearly fits. Tabs still loose that are related to each other then form
  // new groups of their own (2+; 4+ loose tabs at the normal threshold, 2-3 need stronger evidence).
  // Every batch is one step for undoOrganize. Returns whether anything changed.
  function autoGroupTopics({ cluster = true } = {}) {
    const groupsBefore = [...groups.keys()];
    const autoGroups = [...groups.values()].filter((g) => g.auto);
    const moves = new Map(); // tab id -> the group it was in before (null: none)
    const record = (tab) => { if (!moves.has(tab.id)) moves.set(tab.id, tab.groupId || null); };
    const candidates = getTabs().filter((t) => movable(t) && (t.autoMoves || 0) < MAX_AUTO_MOVES
      && (t.groupId ? groups.get(t.groupId)?.auto && t.autoKey !== keyOf(t) : true));
    if (autoGroups.length && candidates.length) {
      const groupList = autoGroups.map((g) => ({ id: g.id, name: g.name, domain: g.domain, members: members(g.id).map(entry) }));
      const candidateIds = new Set(candidates.map((t) => t.id));
      const background = loose().filter((t) => !candidateIds.has(t.id)).map(entry);
      const result = placeTabs(candidates.map((t) => ({ entry: entry(t), current: t.groupId || null })), groupList, { background, bonus: learned ? (e, g) => learned.affinity(e, g.name) : null });
      candidates.forEach((tab, i) => {
        tab.autoKey = keyOf(tab);
        if (result[i] == null) return;
        record(tab);
        tab.groupId = result[i];
        tab.autoMoves = (tab.autoMoves || 0) + 1;
      });
    }
    const rest = loose();
    if (cluster && rest.length >= 2) {
      const threshold = rest.length >= 4 ? TOPIC_THRESHOLD : LOOSE_PAIR_THRESHOLD;
      for (const c of topicClusters(rest.map(entry), { threshold })) {
        const ids = c.ids.filter((id) => !tabById(id)?.groupId);
        if (ids.length < 2) continue;
        for (const id of ids) record(tabById(id));
        create(uniqueName(c.name), ids, { topic: c.key, auto: true });
        for (const id of ids) tabById(id).autoMoves = 1;
      }
    }
    const merged = groups.size > groupsBefore.length ? mergeSimilar(moves) : { touched: [] };
    if (!moves.size) return false;
    autoUndo = { seq: ++undoSeq, moves, groups: merged.touched };
    arrange();
    cleanup();
    return true;
  }

  // Three or more ungrouped tabs from one site form a group; later tabs of that site join it.
  function autoGroup() {
    if (!isAuto()) return false;
    if (mode() === 'topic') return autoGroupTopics({ cluster: !aiTopics?.() }); // with AI naming on, main clusters through the model
    let changed = false;
    const bySite = new Map();
    for (const tab of getTabs()) {
      if (tab.groupId || pinned(tab) || tab.userRemoved || tab.userMoved || tab.userPlaced || !isWeb(urlOf(tab))) continue;
      const domain = siteKey(urlOf(tab));
      if (!domain || SEARCH_DOMAINS.has(domain)) continue; // result pages from a search engine aren't a topic
      if (!bySite.has(domain)) bySite.set(domain, []);
      bySite.get(domain).push(tab);
    }
    for (const [domain, list] of bySite) {
      const existing = [...groups.values()].find((g) => g.domain === domain);
      if (existing) {
        for (const tab of list) tab.groupId = existing.id;
        changed = true;
      } else if (list.length >= 3) {
        create(uniqueName(siteName(urlOf(list[0]), titleOf(list[0]))), list.map((t) => t.id), { domain, auto: true });
        changed = true;
      }
    }
    if (changed) { arrange(); cleanup(); }
    return changed;
  }

  function saveUndo() {
    undoState = {
      seq: ++undoSeq,
      order: getTabs().map((t) => t.id),
      tabs: new Map(getTabs().map((t) => [t.id, t.groupId || null])),
      flags: new Map(getTabs().map((t) => [t.id, { userRemoved: Boolean(t.userRemoved), userPlaced: Boolean(t.userPlaced), autoMoves: t.autoMoves || 0 }])),
      groups: snapshot(),
    };
    autoUndo = null; // this step includes everything the automatic ones did
  }

  // "Organize Tabs by Topic" / "Organize with AI": loose tabs and tabs in automatic groups are regrouped,
  // from the local clusters or a proposal ([{ name, tab_ids }] from an AI model; anything unusable in it
  // falls back to the local clusters). Groups the user made, and tabs the user took out of groups,
  // dragged, or pinned, stay as they are. A new group that mostly matches an old automatic one keeps
  // its colour (and, for local clusters, its name) so the tab strip doesn't reshuffle. One step of undo.
  function organizeByTopic(proposal = null) {
    saveUndo();
    const prior = [...groups.values()].filter((g) => g.auto).map((g) => ({ ...g, ids: new Set(members(g.id).map((t) => t.id)) }));
    for (const g of prior) ungroupAll(g.id);
    for (const t of getTabs()) { t.autoMoves = 0; t.autoKey = null; }
    const before = new Set(groups.keys());
    const count = groupLoose(proposal, { prior });
    orderGroupsByRecency();
    spreadColors(new Set([...groups.keys()].filter((id) => !before.has(id))));
    return count;
  }

  // The groups Organize made sit in the strip by how recently their tabs were used, most recent first.
  // Only the places those groups already held are reshuffled: loose, pinned and user-made groups stay put.
  const usedAt = (t) => Math.max(t.lastActiveAt || 0, t.viewedAt || 0);
  function orderGroupsByRecency() {
    const blocks = [];
    const seen = new Set();
    for (const t of getTabs()) {
      if (!t.groupId) blocks.push({ tabs: [t] });
      else if (!seen.has(t.groupId)) { seen.add(t.groupId); blocks.push({ gid: t.groupId, tabs: members(t.groupId) }); }
    }
    const mine = (b) => { const g = b.gid && groups.get(b.gid); return Boolean(g) && g.auto && !g.userNamed && !g.domain; };
    const slots = blocks.map((b, i) => (mine(b) ? i : -1)).filter((i) => i >= 0);
    if (slots.length < 2) return;
    const recent = (b) => Math.max(...b.tabs.map(usedAt));
    const sorted = slots.map((i) => blocks[i]).map((b, k) => ({ b, k })).sort((x, y) => recent(y.b) - recent(x.b) || x.k - y.k).map((x) => x.b);
    slots.forEach((slot, i) => { blocks[slot] = sorted[i]; });
    setTabs(blocks.flatMap((b) => b.tabs));
  }

  // New groups never share a colour with the group beside them (the colour of a group that already
  // existed, or one the user picked, is never changed).
  function spreadColors(newIds) {
    if (!newIds.size) return;
    const order = [];
    for (const t of getTabs()) if (t.groupId && !order.includes(t.groupId)) order.push(t.groupId);
    const used = new Map(GROUP_COLORS.map((c) => [c, 0]));
    for (const id of order) { const g = groups.get(id); if (g) used.set(g.color, (used.get(g.color) || 0) + 1); }
    order.forEach((id, i) => {
      const g = groups.get(id);
      if (!g || !newIds.has(id) || g.colorLocked) return;
      const near = [order[i - 1], order[i + 1]].map((n) => groups.get(n)?.color).filter(Boolean);
      if (!near.includes(g.color)) return;
      const pick = GROUP_COLORS.filter((c) => !near.includes(c)).sort((a, b) => (used.get(a) || 0) - (used.get(b) || 0))[0];
      if (pick) { used.set(g.color, used.get(g.color) - 1); used.set(pick, (used.get(pick) || 0) + 1); g.color = pick; }
    });
  }
  const applyProposal = organizeByTopic; // the older name: "Organize with AI"

  // Groups loose tabs only: from a proposal ([{ name, tab_ids }]) or the local clusters.
  function groupLoose(proposal = null, { prior = [] } = {}) {
    const pool = loose();
    const poolIds = new Set(pool.map((t) => t.id));
    const proposed = proposal ? sanitizeProposal(proposal, poolIds) : null;
    const clusters = proposed ? proposed.map((g) => ({ name: g.name, ids: g.ids, key: null, ai: true })) : topicClusters(pool.map(entry));
    const used = new Set();
    const claimed = new Set();
    let count = 0;
    for (const c of clusters) {
      const ids = c.ids.filter((id) => !used.has(id));
      if (ids.length < 2 || !c.name) continue;
      ids.forEach((id) => used.add(id));
      // The old automatic group these tabs mostly came from (stable colour and name).
      const old = prior.filter((p) => !claimed.has(p.id)).map((p) => ({ p, n: ids.filter((id) => p.ids.has(id)).length }))
        .filter(({ p, n }) => n >= 2 && n >= Math.min(ids.length, p.ids.size) / 2).sort((a, b) => b.n - a.n)[0]?.p;
      // A model's group named like a group that exists: the tabs join it rather than a twin.
      const twin = c.ai && [...groups.values()].find((g) => g.name.toLowerCase() === c.name.toLowerCase());
      if (twin) {
        for (const id of ids) add(id, twin.id, { auto: true });
        count++;
        continue;
      }
      if (old) claimed.add(old.id);
      // A name the user gave this kind of group before (renamed it, or filed such tabs under it) wins over the automatic one.
      const taught = !c.ai && !old && learned ? learned.nameFor(ids.map((id) => entry(tabById(id))), c.name) : c.name;
      create(uniqueName(old && !c.ai ? old.name : taught), ids, { topic: c.key, auto: true, color: old?.color, cohesion: c.cohesion });
      count++;
    }
    arrange();
    cleanup();
    return count > 0 ? Math.max(count - mergeSimilar().gone, 1) : 0;
  }

  // The topic groups "Organize" made (automatic ones the user hasn't named) with their tabs, and the tabs
  // still loose: what a model is asked to refine. Read only.
  function organizeView() {
    const isCandidate = (t) => !pinned(t) && !t.userRemoved && !t.userMoved && !t.userPlaced && isWeb(urlOf(t));
    const list = [];
    for (const g of groups.values()) {
      if (!g.auto || g.userNamed || g.domain) continue;
      const entries = members(g.id).filter(isCandidate).map(entry);
      if (entries.length) list.push({ id: g.id, name: g.name, cohesion: g.cohesion, entries });
    }
    return { groups: list, leftovers: loose().map(entry) };
  }

  // Phase two of "Organize with AI" (see features/organize-ai.js planApply): rename groups in place, put
  // loose tabs into groups, form new groups from loose tabs, merge groups. It changes nothing the user
  // changed meanwhile, and adds no step of undo: it belongs to the organize step `seq` names, and does
  // nothing at all once that step was undone or another one was made.
  function applyRefinement({ renames = [], places = [], groups: created = [], merges = [] } = {}, { seq = null } = {}) {
    const out = { renamed: 0, placed: 0, created: 0, merged: 0 };
    if (seq != null && undoState?.seq !== seq) return out;
    const mine = (g) => g && g.auto && !g.userNamed;
    for (const { into, from } of merges) {
      const keep = groups.get(into);
      const gone = groups.get(from);
      if (!mine(keep) || !mine(gone)) continue;
      for (const tab of members(from)) if (!pinned(tab)) tab.groupId = into;
      groups.delete(from);
      out.merged++;
    }
    for (const { id, name } of renames) {
      const g = groups.get(id);
      const clean = cleanGroupName(name);
      if (!mine(g) || !clean) continue;
      g.name = uniqueName(clean, id).slice(0, 40);
      out.renamed++;
    }
    for (const { tab: tabId, group } of places) {
      const tab = tabById(tabId);
      if (!tab || tab.groupId || !movable(tab) || !groups.get(group)) continue;
      tab.groupId = group;
      tab.autoKey = keyOf(tab);
      out.placed++;
    }
    for (const { name, ids } of created) {
      const free = ids.filter((id) => { const t = tabById(id); return t && !t.groupId && movable(t); });
      if (free.length < 2) continue;
      create(uniqueName(cleanGroupName(name)), free, { auto: true });
      out.created++;
    }
    if (out.merged || out.renamed || out.placed || out.created) { arrange(); cleanup(); }
    return out;
  }

  // The idle rule's organizer: only the loose tabs are grouped (local clusters), automatic groups stay as they
  // are. One step of undo, and nothing recorded when nothing was grouped. Returns how many groups were made.
  function organizeLoose() {
    const prev = { undoState, autoUndo, undoSeq };
    saveUndo();
    const before = new Set(groups.keys());
    const count = groupLoose();
    if (!count) { ({ undoState, autoUndo, undoSeq } = prev); return 0; }
    spreadColors(new Set([...groups.keys()].filter((id) => !before.has(id))));
    return count;
  }

  // "Merge Similar Groups": one step of undo, nothing recorded when there was nothing to merge.
  function mergeGroups() {
    const prev = { undoState, autoUndo, undoSeq };
    saveUndo();
    const { gone } = mergeSimilar();
    if (!gone) ({ undoState, autoUndo, undoSeq } = prev);
    return gone;
  }

  // Undoes the most recent thing: an organize, or the last automatic by-topic placement.
  function undoOrganize() {
    if (autoUndo && (!undoState || autoUndo.seq > undoState.seq)) return undoAuto();
    if (!undoState) return false;
    const { order, tabs: saved, groups: savedGroups, flags } = undoState;
    undoState = null;
    groups.clear();
    restore(savedGroups);
    const byId = new Map(getTabs().map((t) => [t.id, t]));
    const list = order.filter((id) => byId.has(id)).map((id) => byId.get(id));
    for (const t of getTabs()) if (!list.includes(t)) list.push(t); // opened since
    for (const t of list) {
      if (!saved.has(t.id)) continue;
      t.groupId = groups.has(saved.get(t.id)) ? saved.get(t.id) : null;
      Object.assign(t, flags.get(t.id));
    }
    setTabs(list);
    arrange();
    cleanup();
    return true;
  }

  // Puts the tabs the last automatic pass moved back where they were. They are then left alone, so
  // the same pass doesn't just move them again.
  function undoAuto() {
    const { moves, groups: touched } = autoUndo;
    autoUndo = null;
    for (const g of touched || []) groups.set(g.id, { ...g }); // groups a merge changed or removed
    for (const [id, from] of moves) {
      const tab = tabById(id);
      if (!tab) continue;
      tab.groupId = from && groups.has(from) ? from : null;
      tab.userRemoved = true;
    }
    arrange();
    cleanup();
    return true;
  }

  const state = () => {
    const order = [];
    for (const tab of getTabs()) if (tab.groupId && !order.includes(tab.groupId)) order.push(tab.groupId);
    return order.map((id) => groups.get(id)).filter(Boolean).map(({ id, name, color, collapsed }) => ({ id, name, color, collapsed }));
  };

  const snapshot = () => [...groups.values()].map(({ id, name, color, collapsed, domain, topic, auto, userNamed, colorLocked }) => ({ id, name, color, collapsed, domain, topic, auto, userNamed: Boolean(userNamed), colorLocked: Boolean(colorLocked) }));

  function restore(saved) {
    for (const g of saved || []) {
      groups.set(g.id, { id: g.id, name: g.name, color: GROUP_COLORS.includes(g.color) ? g.color : 'gray', collapsed: Boolean(g.collapsed), domain: g.domain || null, topic: g.topic || null, auto: g.auto ?? Boolean(g.domain), userNamed: Boolean(g.userNamed), colorLocked: Boolean(g.colorLocked) });
      nextId = Math.max(nextId, g.id + 1);
    }
    colorIndex = groups.size;
  }

  return {
    groups, GROUP_COLORS, create, add, remove, ungroupAll, joinOpener, autoGroup, applyProposal, organizeByTopic, groupLoose, organizeLoose, mergeGroups, entryFor: (id) => { const t = tabById(id); return t ? entry(t) : null; }, groupEntries: (id) => members(id).map(entry), organizeView, applyRefinement, organizeSeq: () => (undoState ? undoState.seq : null), undoOrganize, canUndo: () => Boolean(undoState || autoUndo), loose: () => loose().map(entry),
    // What "Organize by topic" regroups: loose tabs and tabs in automatic groups.
    candidates: () => getTabs().filter((t) => (!t.groupId || groups.get(t.groupId)?.auto) && !pinned(t) && !t.userRemoved && !t.userMoved && !t.userPlaced && isWeb(urlOf(t))).map(entry), arrange, cleanup, state, snapshot, restore, members,
    changed: onChange,
  };
}

module.exports = { createTabGroups, isTransientTitle, isAppOrSearch, tokens, stripSiteSegment, cleanGroupName, siteName, registrableDomain, siteKey, topicClusters, mergeSimilarGroups, nameSimilarity, placeTabs, sanitizeProposal, pathWords, GROUP_COLORS, MAX_AUTO_MOVES };
