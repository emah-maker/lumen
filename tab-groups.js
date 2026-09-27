// Tab groups: the model, automatic grouping rules, and site names. main.js owns the tabs; this
// module works on the same array through the accessors passed to createTabGroups().
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
function registrableDomain(url) {
  const host = hostname(url);
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const second = parts[parts.length - 2];
  const secondLevel = parts[parts.length - 1].length === 2 && /^(co|com|org|net|gov|ac|edu|ne|or)$/.test(second);
  return parts.slice(secondLevel ? -3 : -2).join('.');
}

// A short human name for a site: known names first, then a page-title suffix that matches the
// domain ("Title - Wikipedia"), then the capitalised domain label.
function siteName(url, title = '') {
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
// TF-IDF over each tab's words (title, site name, address path) with cosine similarity and
// average-linkage clustering. Words only one tab has can't link two tabs, and words most tabs
// share say nothing, so both are dropped before comparing; unrelated tabs stay loose.

const STOPWORDS = new Set(`a an and are as at be by for from has have how i in is it its of on or our that the this to was what when where which who why will with you your
about after all also any best can com could do does get go guide home into just like login more most new news no not now official one only other out over page
said see sign site so some than them then there these they top up us use using via vs was way we web welcome were what www html htm php aspx index amp http https
official free online app video videos watch search results result edit view log docs doc wiki org net io co uk en de fr es de`.split(/\s+/));
const TOPIC_THRESHOLD = 0.34;

const stem = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w);

// Words of one tab: stem -> the surface form first seen (for naming).
function tabWords({ title = '', url = '' }) {
  const words = new Map();
  const add = (text, weight) => {
    for (const raw of String(text).split(/[^\p{L}\p{N}]+/u)) {
      const w = raw.toLowerCase();
      if (w.length < 3 || /^\d+$/.test(w) || STOPWORDS.has(w)) continue;
      const key = stem(w);
      const entry = words.get(key) || { weight: 0, surface: raw };
      entry.weight = Math.max(entry.weight, weight);
      words.set(key, entry);
    }
  };
  add(title, 1);
  let pathname = '';
  try { ({ pathname } = new URL(url)); } catch {}
  const label = registrableDomain(url).split('.')[0];
  if (label && !SEARCH_DOMAINS.has(registrableDomain(url))) add(label, 0.8);
  add(decodeURIComponent(pathname).replace(/[-_]/g, ' '), 0.5);
  return words;
}

const topicWords = (e) => new Set(tabWords(e).keys());

// entries: [{ id, title, url }] -> [{ name, ids, key }] with 2+ tabs each (loose tabs left out).
function topicClusters(entries, { threshold = TOPIC_THRESHOLD } = {}) {
  const docs = entries.map((e) => ({ ...e, words: tabWords(e) }));
  const n = docs.length;
  if (n < 2) return [];
  const df = new Map();
  for (const d of docs) for (const key of d.words.keys()) df.set(key, (df.get(key) || 0) + 1);
  const informative = (key) => df.get(key) >= 2 && (n < 4 || df.get(key) / n <= 0.7);
  const idf = (key) => Math.log((n + 1) / (df.get(key) + 1)) + 1;
  for (const d of docs) {
    d.vec = new Map();
    for (const [key, { weight }] of d.words) if (informative(key)) d.vec.set(key, weight * idf(key));
    d.norm = Math.hypot(...d.vec.values());
  }
  const cos = (a, b) => {
    if (!a.norm || !b.norm) return 0;
    let dot = 0;
    for (const [k, v] of a.vec) if (b.vec.has(k)) dot += v * b.vec.get(k);
    return dot / (a.norm * b.norm);
  };
  const sim = docs.map((a) => docs.map((b) => cos(a, b)));
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
  return clusters.filter((c) => c.length >= 2).map((c) => {
    const members = c.map((i) => docs[i]);
    // Name: the cluster's strongest shared word (two if the second is nearly as strong).
    const score = new Map();
    for (const d of members) for (const [k, v] of d.vec) score.set(k, (score.get(k) || 0) + v);
    const ranked = [...score].filter(([k]) => members.filter((d) => d.vec.has(k)).length >= Math.ceil(members.length / 2)).sort((a, b) => b[1] - a[1]);
    const surface = (k) => members.find((d) => d.words.has(k)).words.get(k).surface;
    const titleCase = (w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w);
    const [top, second] = ranked;
    const siteOnly = top && members.every((d) => registrableDomain(d.url) === registrableDomain(members[0].url)) && registrableDomain(members[0].url).startsWith(top[0]);
    let name = siteOnly ? siteName(members[0].url, members[0].title) : top ? titleCase(surface(top[0])) : siteName(members[0].url, members[0].title);
    if (!siteOnly && second && second[1] >= top[1] * 0.8) name = `${name} ${titleCase(surface(second[0]))}`;
    return { name, ids: members.map((d) => d.id), key: top?.[0] || null };
  });
}

// mode(): 'off' | 'site' | 'topic' (automatic grouping).
function createTabGroups({ getTabs, setTabs, urlOf, titleOf, isWeb, mode, aiTopics, onChange }) {
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
  const entry = (t) => ({ id: t.id, title: titleOf(t), url: urlOf(t) });

  // By topic: loose tabs join a topic group that shares its word; 4+ loose tabs are clustered.
  function autoGroupTopics({ cluster = true } = {}) {
    let changed = false;
    const topicGroups = [...groups.values()].filter((g) => g.topic);
    for (const tab of loose()) {
      const words = topicWords(entry(tab));
      const match = topicGroups.find((g) => words.has(g.topic));
      if (match) { tab.groupId = match.id; changed = true; }
    }
    const rest = loose();
    if (cluster && rest.length >= 4) {
      for (const c of topicClusters(rest.map(entry))) {
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
      const domain = registrableDomain(urlOf(tab));
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

module.exports = { createTabGroups, siteName, registrableDomain, topicClusters, GROUP_COLORS };
