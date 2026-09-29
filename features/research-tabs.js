// ---------- research tabs: show what the AI is searching / reading ----------
// When the agent runs web_search or read_urls (sidebar, batch, Claude Code / Grok Build, MCP), the
// pages it looks at also open as visible BACKGROUND tabs in one group ("AI: <query>"), so the user
// can watch the research and keep the sources. This is a transparency side effect only: what the
// agent actually reads still comes from the hidden fetch (agent.js readInBackground / searchWeb),
// so tool results, taint wrapping and every safety check are unchanged.
//
// Pure logic; main.js injects the browser side:
//   enabled()                 the "Show AI research in tabs" setting
//   isAiOff(url)              the user turned AI off on that site: no tab is opened for it
//   searchUrl(query)          the user's default search engine URL for a query
//   openTab(url, {groupId})   opens a background tab in the run's window, returns its id (or null)
//   navigateTab(id, url)      loads a URL in an existing research tab
//   tabExists(id)             is that tab still open (the user may have closed it)
//   createGroup(name, ids)    groups tabs, returns the group id
//   groupExists(groupId)      is the group still there
//   setReading(id, on)        the "AI is reading" marker on a tab
// A run key is any object (the agent's task scope) or a string; nothing is opened for a run whose
// tabs the user closed twice over.
const MAX_TABS = 6; // research tabs per run; after that the oldest is navigated to the next page
const GROUP_COLOR = 'purple';
const IDLE_MS = 90 * 1000; // an MCP client has no run: its research is "one run" until it goes quiet this long

function shortQuery(query, max = 32) {
  const q = String(query ?? '').replace(/\s+/g, ' ').trim();
  if (q.length <= max) return q;
  const cut = q.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}
const groupName = (label) => `AI: ${shortQuery(label) || 'research'}`;

// Two spellings of one page count as one: the fragment and a trailing slash don't matter.
function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    let s = u.href;
    if (u.pathname === '/' && !u.search) s = s.replace(/\/$/, '');
    return s;
  } catch { return null; }
}
const hostOf = (raw) => { try { return new URL(raw).hostname.toLowerCase(); } catch { return ''; } };

function createResearchTabs(deps, { max = MAX_TABS, idleMs = IDLE_MS, now = () => Date.now() } = {}) {
  const runs = new Map(); // run key -> { seen: Set(normalized url), tabs: [{ id, url }], groupId, reading: Set(id), last }
  const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

  function runFor(key) {
    let run = runs.get(key);
    if (run && key === 'external' && now() - run.last > idleMs) { finish(key); run = null; }
    if (!run) { run = { seen: new Set(), tabs: [], groupId: null, reading: new Set(), last: now() }; runs.set(key, run); }
    run.last = now();
    return run;
  }

  // Opens (or reuses) a tab for `url` in the run's group. Returns the tab id, or null when nothing
  // was opened.
  function show(run, url, label) {
    const norm = normalizeUrl(url);
    if (!norm) return null;
    if (safe(() => deps.isAiOff?.(norm), false)) return null; // [ai controls] such a site is never shown either
    const known = run.tabs.find((t) => t.norm === norm);
    if (known) {
      if (safe(() => deps.tabExists(known.id), false)) return known.id;
      run.tabs.splice(run.tabs.indexOf(known), 1); // the user closed it; a repeat may open it again
    } else if (run.seen.has(norm)) return null;
    run.seen.add(norm);
    run.tabs = run.tabs.filter((t) => safe(() => deps.tabExists(t.id), false) || (run.seen.delete(t.norm), false)); // closed by the user: may be shown again
    if (run.groupId && !safe(() => deps.groupExists(run.groupId), false)) run.groupId = null; // the user closed the group
    if (run.tabs.length >= max) { // full: reuse the oldest research tab
      const oldest = run.tabs.shift();
      run.reading.delete(oldest.id);
      run.seen.delete(oldest.norm);
      safe(() => deps.navigateTab(oldest.id, url));
      run.tabs.push({ id: oldest.id, url, norm });
      return oldest.id;
    }
    const id = safe(() => deps.openTab(url, run.groupId ? { groupId: run.groupId } : {}));
    if (id == null) return null;
    if (!run.groupId) run.groupId = safe(() => deps.createGroup(groupName(label), [id]));
    run.tabs.push({ id, url, norm });
    return id;
  }

  function setReading(run, ids, on) {
    for (const id of ids) {
      if (on) run.reading.add(id); else run.reading.delete(id);
      safe(() => deps.setReading(id, on));
    }
  }

  // Call when a web_search / read_urls starts. `what` is { query } or { urls }. Returns a function to
  // call when the tool call ends (success or not), which drops the reading marker. Never throws.
  function begin(key, what = {}) {
    if (!safe(() => deps.enabled(), false)) return () => {};
    return safe(() => {
      const run = runFor(key);
      const ids = [];
      const add = (id) => { if (id != null && !ids.includes(id)) ids.push(id); };
      if (typeof what.query === 'string' && what.query.trim()) {
        const url = safe(() => deps.searchUrl(what.query));
        if (url) {
          // The search page opens first, so it names the group; a later read_urls joins that group.
          add(show(run, url, what.query));
        }
      }
      if (Array.isArray(what.urls)) {
        const label = what.label || (run.groupId ? '' : hostOf(what.urls[0]));
        for (const u of what.urls.slice(0, max)) add(show(run, u, label));
      }
      setReading(run, ids, true);
      return () => setReading(run, ids, false);
    }, () => {}) || (() => {});
  }

  // The run is over: the tabs stay (the user wants the sources) but nothing is "being read" any more.
  function finish(key) {
    const run = runs.get(key);
    if (!run) return;
    setReading(run, [...run.reading], false);
    runs.delete(key);
  }

  return { begin, finish, has: (key) => runs.has(key), tabCount: (key) => runs.get(key)?.tabs.length || 0 };
}

module.exports = { createResearchTabs, shortQuery, groupName, normalizeUrl, MAX_TABS, GROUP_COLOR, IDLE_MS };
