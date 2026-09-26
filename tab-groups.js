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

function createTabGroups({ getTabs, setTabs, urlOf, titleOf, isWeb, isAuto, onChange }) {
  const groups = new Map(); // id -> { id, name, color, collapsed, domain }
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

  function create(name, tabIds, { domain = null, color } = {}) {
    const group = {
      id: nextId++,
      name: String(name || 'Group').slice(0, 40),
      color: GROUP_COLORS.includes(color) ? color : GROUP_COLORS[colorIndex++ % GROUP_COLORS.length],
      collapsed: false,
      domain,
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

  // Three or more ungrouped tabs from one site form a group; later tabs of that site join it.
  function autoGroup() {
    if (!isAuto()) return false;
    let changed = false;
    const bySite = new Map();
    for (const tab of getTabs()) {
      if (tab.groupId || tab.userRemoved || !isWeb(urlOf(tab))) continue;
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
        create(siteName(urlOf(list[0]), titleOf(list[0])), list.map((t) => t.id), { domain });
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

  const state = () => {
    const order = [];
    for (const tab of getTabs()) if (tab.groupId && !order.includes(tab.groupId)) order.push(tab.groupId);
    return order.map((id) => groups.get(id)).filter(Boolean).map(({ id, name, color, collapsed }) => ({ id, name, color, collapsed }));
  };

  const snapshot = () => [...groups.values()].map(({ id, name, color, collapsed, domain }) => ({ id, name, color, collapsed, domain }));

  function restore(saved) {
    for (const g of saved || []) {
      groups.set(g.id, { id: g.id, name: g.name, color: GROUP_COLORS.includes(g.color) ? g.color : 'gray', collapsed: Boolean(g.collapsed), domain: g.domain || null });
      nextId = Math.max(nextId, g.id + 1);
    }
    colorIndex = groups.size;
  }

  return {
    groups, GROUP_COLORS, create, add, remove, ungroupAll, joinOpener, autoGroup, applyProposal, arrange, cleanup, state, snapshot, restore, members,
    changed: onChange,
  };
}

module.exports = { createTabGroups, siteName, registrableDomain, GROUP_COLORS };
