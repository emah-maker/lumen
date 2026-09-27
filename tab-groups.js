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
time times visit deal deals thing things day days week weeks year years review reviews reviewed rated tips ideas
library libraries open source powerful comprehensive community resources ecosystem platform`.split(/\s+/));
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
function tabWords({ title = '', url = '', text = '' }) {
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
  const cleanTitle = stripSiteSegment(title, url);
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
  if (titleTokens.length <= 2) for (const g of charTrigrams(cleanTitle)) if (!words.has(g)) words.set(g, { weight: 0.4, surface: g });
  words.bigrams = bigrams;
  return words;
}

// TF-IDF vectors for a set of entries, idf computed over just this set ("current tabs").
function vectorize(entries) {
  const docs = entries.map((e) => ({ ...e, words: tabWords(e), site: registrableDomain(e.url) }));
  const n = docs.length;
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
    for (const [k, c] of count) if (c / idxs.length >= SITE_TEMPLATE_RATIO && df.get(k) === c) for (const i of idxs) docs[i].template.add(k);
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

// entries: [{ id, title, url }] -> [{ name, ids, key }] with 2+ tabs each (loose tabs left out).
function topicClusters(entries, { threshold = TOPIC_THRESHOLD } = {}) {
  const docs = vectorize(entries);
  const n = docs.length;
  if (n < 2) return [];
  const sim = docs.map((a) => docs.map((b) => cosine(a, b)));
  // Average-linkage agglomerative clustering, merging the closest pair while above the threshold.
  let clusters = docs.map((_d, i) => [i]);
  const link = (x, y) => { let s = 0; for (const i of x) for (const j of y) s += sim[i][j]; return s / (x.length * y.length); };
  for (;;) {
    let best = null;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const s = link(clusters[i], clusters[j]);
        if (s >= threshold && (!best || s > best.s)) best = { i, j, s };
      }
    }
    if (!best) break;
    clusters[best.i] = clusters[best.i].concat(clusters[best.j]);
    clusters.splice(best.j, 1);
  }
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
  clusters = merged;
  const titleCase = (w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w);
  const titleCasePhrase = (s) => s.split(/\s+/).map(titleCase).join(' ');
  const clip = (s) => (s.length <= 24 ? s : (s.slice(0, 24).replace(/\s+\S*$/, '') || s.slice(0, 24)));
  return clusters.filter((c) => c.length >= 2).map((c) => {
    const members = c.map((i) => docs[i]);
    const isReal = (k) => !k.startsWith('#') && !k.startsWith('~'); // trigram/vector-bigram keys are similarity-only, never names
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
    let name;
    if (siteOnly) name = siteName(members[0].url, members[0].title);
    else if (bigramRanked.length) name = titleCasePhrase(bigramRanked[0].surface);
    else if (top) name = titleCase(surface(top[0]));
    else name = siteName(members[0].url, members[0].title);
    return { name: clip(name), ids: members.map((d) => d.id), key: top?.[0] || null };
  });
}

// mode(): 'off' | 'site' | 'topic' (automatic grouping).
function createTabGroups({ getTabs, setTabs, urlOf, titleOf, textOf, isWeb, mode, aiTopics, onChange }) {
  const groups = new Map(); // id -> { id, name, color, collapsed, domain, topic, auto }
  const isAuto = () => mode() !== 'off';
  let undoState = null; // the tabs and groups from before the last "Organize by topic"
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

  function create(name, tabIds, { domain = null, color, topic = null, auto = false } = {}) {
    const group = {
      id: nextId++,
      name: String(name || 'Group').slice(0, 40),
      color: GROUP_COLORS.includes(color) ? color : GROUP_COLORS[colorIndex++ % GROUP_COLORS.length],
      collapsed: false,
      domain,
      topic, // the shared word a topic group was formed on; later tabs with it join
      auto, // made by automatic grouping (can be re-organized); groups the user made never are
    };
    groups.set(group.id, group);
    for (const id of tabIds) {
      const tab = tabById(id);
      if (tab) { tab.groupId = group.id; tab.userRemoved = false; }
    }
    cleanup();
    arrange();
    return group;
  }

  function add(tabId, groupId) {
    const tab = tabById(tabId);
    if (!tab || !groups.has(groupId)) return false;
    tab.groupId = groupId;
    tab.userRemoved = false;
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
    // Opened tabs sit right after the opener (or its group), like Safari and Chrome.
    const list = getTabs().filter((t) => t !== tab);
    const at = opener.groupId ? list.map((t) => t.groupId).lastIndexOf(opener.groupId) : list.indexOf(opener);
    list.splice(at + 1, 0, tab);
    setTabs(list);
    // One link opened in a new tab is not a topic: it only joins a group the opener is already in.
    if (opener.groupId && groups.has(opener.groupId)) add(tab.id, opener.groupId);
  }

  // Tabs automatic grouping may move: ungrouped web tabs the user hasn't taken out of a group
  // or dragged into place.
  const loose = () => getTabs().filter((t) => !t.groupId && !t.userRemoved && !t.userMoved && isWeb(urlOf(t)));
  const entry = (t) => ({ id: t.id, title: titleOf(t), url: urlOf(t), text: textOf ? textOf(t) : '' });

  // By topic: a loose tab joins the topic group its words are most similar to (centroid, same
  // IDF as the rest of the current tabs) - not just the first group whose key word it happens to
  // contain, which let generic words ("review", "2026") drag unrelated tabs into a group and
  // ignored what the rest of the group was actually about. 4+ remaining loose tabs cluster at the
  // normal threshold; 2-3 need stronger similarity, since fewer members corroborate the overlap.
  function autoGroupTopics({ cluster = true } = {}) {
    let changed = false;
    const topicGroups = [...groups.values()].filter((g) => g.topic);
    const looseTabs = loose();
    if (topicGroups.length && looseTabs.length) {
      const groupEntries = topicGroups.map((g) => members(g.id).map(entry));
      const docs = vectorize([...looseTabs.map(entry), ...groupEntries.flat()]);
      let at = looseTabs.length;
      const centroids = groupEntries.map((list) => { const slice = docs.slice(at, at + list.length); at += list.length; return centroidOf(slice); });
      const looseDocs = docs.slice(0, looseTabs.length);
      looseTabs.forEach((tab, i) => {
        let bestJ = -1;
        let bestSim = TOPIC_THRESHOLD;
        centroids.forEach((c, j) => { const s = cosine(looseDocs[i], c); if (s >= bestSim) { bestSim = s; bestJ = j; } });
        if (bestJ >= 0) { tab.groupId = topicGroups[bestJ].id; changed = true; }
      });
    }
    const rest = loose();
    if (cluster && rest.length >= 2) {
      const threshold = rest.length >= 4 ? TOPIC_THRESHOLD : LOOSE_PAIR_THRESHOLD;
      for (const c of topicClusters(rest.map(entry), { threshold })) {
        create(c.name, c.ids, { topic: c.key, auto: true });
        changed = true;
      }
    }
    if (changed) { arrange(); cleanup(); }
    return changed;
  }

  // Three or more ungrouped tabs from one site form a group; later tabs of that site join it.
  function autoGroup() {
    if (!isAuto()) return false;
    if (mode() === 'topic') return autoGroupTopics({ cluster: !aiTopics?.() }); // with AI naming on, main clusters through the model
    let changed = false;
    const bySite = new Map();
    for (const tab of getTabs()) {
      if (tab.groupId || tab.userRemoved || tab.userMoved || !isWeb(urlOf(tab))) continue;
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
        create(siteName(urlOf(list[0]), titleOf(list[0])), list.map((t) => t.id), { domain, auto: true });
        changed = true;
      }
    }
    if (changed) { arrange(); cleanup(); }
    return changed;
  }

  // Replace groups with a proposed set: [{ name, tab_ids }]. Singletons stay ungrouped.
  function applyProposal(proposal) {
    const used = new Set();
    const valid = [];
    for (const g of proposal || []) {
      const ids = [...new Set((g.tab_ids || []).map(Number))].filter((id) => tabById(id) && !used.has(id));
      if (ids.length < 2 || !g.name) continue;
      ids.forEach((id) => used.add(id));
      valid.push({ name: String(g.name).split(/\s+/).slice(0, 3).join(' '), ids });
    }
    for (const id of [...groups.keys()]) ungroupAll(id);
    for (const tab of getTabs()) tab.userRemoved = false;
    for (const g of valid) create(g.name, g.ids);
    return valid.length;
  }

  // "Organize Tabs by Topic": loose tabs and tabs in automatic groups are regrouped, from the
  // local clusters or a proposal ([{ name, tab_ids }], e.g. from an AI model). Groups the user
  // made, and tabs the user took out of groups or dragged, stay as they are. One step of undo.
  function organizeByTopic(proposal = null) {
    undoState = { order: getTabs().map((t) => t.id), tabs: new Map(getTabs().map((t) => [t.id, t.groupId || null])), groups: snapshot() };
    for (const g of [...groups.values()]) if (g.auto) ungroupAll(g.id);
    return groupLoose(proposal);
  }

  // Groups loose tabs only: from a proposal ([{ name, tab_ids }]) or the local clusters.
  function groupLoose(proposal = null) {
    const pool = loose();
    const poolIds = new Set(pool.map((t) => t.id));
    const clusters = proposal
      ? proposal.map((g) => ({ name: String(g.name || '').split(/\s+/).slice(0, 3).join(' '), ids: [...new Set((g.tab_ids || []).map(Number))].filter((id) => poolIds.has(id)), key: null }))
      : topicClusters(pool.map(entry));
    const used = new Set();
    let count = 0;
    for (const c of clusters) {
      const ids = c.ids.filter((id) => !used.has(id));
      if (ids.length < 2 || !c.name) continue;
      ids.forEach((id) => used.add(id));
      create(c.name, ids, { topic: c.key, auto: true });
      count++;
    }
    arrange();
    cleanup();
    return count;
  }

  function undoOrganize() {
    if (!undoState) return false;
    const { order, tabs: saved, groups: savedGroups } = undoState;
    undoState = null;
    groups.clear();
    restore(savedGroups);
    const byId = new Map(getTabs().map((t) => [t.id, t]));
    const list = order.filter((id) => byId.has(id)).map((id) => byId.get(id));
    for (const t of getTabs()) if (!list.includes(t)) list.push(t); // opened since
    for (const t of list) if (saved.has(t.id)) t.groupId = groups.has(saved.get(t.id)) ? saved.get(t.id) : null;
    setTabs(list);
    arrange();
    cleanup();
    return true;
  }

  const state = () => {
    const order = [];
    for (const tab of getTabs()) if (tab.groupId && !order.includes(tab.groupId)) order.push(tab.groupId);
    return order.map((id) => groups.get(id)).filter(Boolean).map(({ id, name, color, collapsed }) => ({ id, name, color, collapsed }));
  };

  const snapshot = () => [...groups.values()].map(({ id, name, color, collapsed, domain, topic, auto }) => ({ id, name, color, collapsed, domain, topic, auto }));

  function restore(saved) {
    for (const g of saved || []) {
      groups.set(g.id, { id: g.id, name: g.name, color: GROUP_COLORS.includes(g.color) ? g.color : 'gray', collapsed: Boolean(g.collapsed), domain: g.domain || null, topic: g.topic || null, auto: g.auto ?? Boolean(g.domain) });
      nextId = Math.max(nextId, g.id + 1);
    }
    colorIndex = groups.size;
  }

  return {
    groups, GROUP_COLORS, create, add, remove, ungroupAll, joinOpener, autoGroup, applyProposal, organizeByTopic, groupLoose, undoOrganize, canUndo: () => Boolean(undoState), loose: () => loose().map(entry),
    // What "Organize by topic" regroups: loose tabs and tabs in automatic groups.
    candidates: () => getTabs().filter((t) => (!t.groupId || groups.get(t.groupId)?.auto) && !t.userRemoved && !t.userMoved && isWeb(urlOf(t))).map(entry), arrange, cleanup, state, snapshot, restore, members,
    changed: onChange,
  };
}

module.exports = { createTabGroups, siteName, registrableDomain, siteKey, topicClusters, GROUP_COLORS };
