// "Organize Tabs with AI", made fast. The local topic organizer (tab-groups.js) applies first and
// instantly; the model only REFINES that result: it names vague groups, places the few tabs the
// local organizer could not, and suggests merges. What it is sent shrinks from every tab to a
// summary per group (top words, a few titles, hosts) plus the leftover tabs, in a compact format.
// When the local result is already clear, or the same tabs were organized before, no request is made.
//
// Pure logic: the tab list, the model and the clock are passed in, so test/units.js and
// scripts/measure-organize.js run it against a fake model.
const crypto = require('crypto');
const tg = require('../browser/tab-groups');
const { AI_HINTS } = require('./topic-knowledge');

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const estimateTokens = (s) => Math.ceil(String(s).length / 3.6);

const TITLE_MAX = 70; // characters of a title in a group's samples
const DESC_MAX = 80; // characters of a leftover tab's description
const MIN_COHESION = 0.25; // a group looser than this is worth a second opinion
const TIMEOUT_MS = 8000; // past this the quick local grouping stays as it is
const MAX_PARALLEL = 3;
const CHUNK_ABOVE_TABS = 120; // more tabs than this: several smaller requests instead of one giant one
const CHUNK_ITEMS = 45; // groups + leftovers per request when chunking
const MAX_HINT_HOSTS = 20; // hosts per request a model is asked what they are for (a few output tokens each)
const GENERIC_NAMES = new Set(['group', 'tabs', 'tab', 'page', 'pages', 'new', 'other', 'misc', 'stuff', 'things', 'links', 'home', 'core concepts', 'getting started']);

// ---------- what a tab is called: stable keys, so the same tabs are recognised next time ----------

const tabKey = (e) => sha(`${hostOf(e.url)}|${clip(e.title, 200).toLowerCase()}`);
const groupKey = (entries) => sha(entries.map(tabKey).sort().join(','));
const setKey = (entries) => sha(entries.map(tabKey).sort().join(','));

// ---------- summaries for the model ----------

function topWords(entries, k = 4) {
  const count = new Map();
  for (const e of entries) {
    const seen = new Set();
    for (const { key, surface } of tg.tokens(tg.stripSiteSegment(e.title || '', e.url || ''))) {
      if (seen.has(key)) continue;
      seen.add(key);
      const c = count.get(key) || { n: 0, surface };
      c.n++;
      count.set(key, c);
    }
  }
  return [...count.values()].filter((c) => c.n >= 2 || entries.length < 3).sort((a, b) => b.n - a.n || b.surface.length - a.surface.length).slice(0, k).map((c) => c.surface.toLowerCase());
}

function hostCounts(entries) {
  const count = new Map();
  for (const e of entries) { const h = hostOf(e.url); if (h) count.set(h, (count.get(h) || 0) + 1); }
  return [...count].sort((a, b) => b[1] - a[1]).map(([h]) => h);
}

// A few tabs that stand for the group: first, middle, last of the members.
function sample(entries, k) {
  if (entries.length <= k) return entries;
  const picks = new Set();
  for (let i = 0; i < k; i++) picks.add(Math.round((i * (entries.length - 1)) / (k - 1)));
  return [...picks].map((i) => entries[i]);
}

const cleanTitle = (e) => clip(tg.stripSiteSegment(e.title || '', e.url || ''), TITLE_MAX);

// A tab's site hint: the fixed table's (features/topic-knowledge.js), else what a model said about
// the site before (e.aiHint, kept by features/organize-learn.js). From the host and path only.
const hintOf = (e) => tg.siteHint(e.url) || e.aiHint || '';

// The site hint most of these tabs have ("School" for Canvas), or ''. It tells the model nothing the
// host doesn't already.
function majorHint(entries) {
  const count = new Map();
  for (const e of entries) { const h = hintOf(e); if (h) count.set(h, (count.get(h) || 0) + 1); }
  return [...count].find(([, n]) => n * 2 > entries.length)?.[0] || '';
}

function groupSummary(g) {
  const shown = sample(g.entries, g.entries.length <= 4 ? 4 : 3);
  const hosts = hostCounts(g.entries);
  const hint = majorHint(g.entries);
  return { i: g.id, n: g.entries.length, x: g.name, h: hosts.slice(0, 2).join(','), ...(hint ? { k: hint } : {}), w: topWords(g.entries).join(' '), ...(g.ctx ? {} : { t: shown.map((e) => [e.id, cleanTitle(e)]) }) };
}

// Leftover tabs grouped by host (a host is written once), each [id, title, short description].
// Never the page text beyond ~80 characters of its description, never an address or query string.
function leftoverSummary(entries) {
  const byHost = {};
  for (const e of entries) {
    const host = hostOf(e.url) || '-';
    const desc = clip(e.text, DESC_MAX);
    (byHost[host] ||= []).push(desc ? [e.id, cleanTitle(e), desc] : [e.id, cleanTitle(e)]);
  }
  return byHost;
}

// view: { groups: [{ id, name, cohesion, entries }], leftovers: [entry] } -> the request body.
// hosts: sites to ask what they are for (q), host names only (see unknownHosts).
function buildWire(view, hosts = []) {
  const wire = { g: view.groups.map(groupSummary) };
  if (view.leftovers.length) wire.u = leftoverSummary(view.leftovers);
  // Site hints of the ungrouped tabs, written once per hint: { School: [tabIds] }.
  const hints = {};
  for (const e of view.leftovers) { const h = hintOf(e); if (h) (hints[h] ||= []).push(e.id); }
  if (Object.keys(hints).length) wire.k = hints;
  if (hosts.length) wire.q = hosts;
  return wire;
}

// The sites among these tabs that no hint is known for: not in the fixed table, not an app or search
// engine, and never answered before (lookup(url) is undefined, see organize-learn aiHint). As host
// names only (tab-groups hintHost: "canvas.northeastern.edu"), each once, at most MAX_HINT_HOSTS.
function unknownHosts(entries, lookup, max = MAX_HINT_HOSTS) {
  const out = [];
  for (const e of entries) {
    if (out.length >= max) break;
    if (tg.siteHint(e.url) || tg.isAppOrSearch(e.url) || lookup(e.url) !== undefined) continue;
    const host = tg.hintHost(e.url);
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

// The same request the way it used to be made: every tab, with host and path words, one long list.
function legacyWire(entries, pathWords = tg.pathWords) {
  return entries.map((e) => ({ id: e.id, title: String(e.title).slice(0, 100), host: hostOf(e.url), ...(pathWords(e.url) ? { path: pathWords(e.url) } : {}) }));
}

const REFINE_PROMPT = `Refine groups of browser tabs. g = groups: i id, n size, x current name, h hosts, k site hint, w top words, t sample [tabId, title]. u = ungrouped tabs by host: [tabId, title, description]. k = site hints of ungrouped tabs: {hint: [tabIds]}. A site hint means the site is nearly always that task (Canvas and Gradescope are School, Indeed is Job search): tabs with one hint, and tabs of one host, usually belong together or in the group with that hint or host, unless their titles are clearly different topics (two courses, two projects). Reply with JSON only, leaving out anything that is fine: n = [{i, s}] a better name (1-3 Title Case words, specific, never just a website) for groups whose name is vague or wrong; p = [{t, i}] put ungrouped tab t in group i when it clearly belongs there; g = [{s, t:[ids]}] a new group of 2+ ungrouped tabs about one topic, named s; m = [{a, b}] merge group b into group a when they are one topic (pieces of one trip, course, search or project are one topic). Leave a tab ungrouped rather than forcing it. Keep names a person chose. Use only the ids given. q = hosts to classify: h = [{s host, k}] for each, k what the site is nearly always used for (${AI_HINTS.join(', ')}), or none when it is used for many things or you do not know it (a university's own site is School).`;

const intItems = (props) => ({ type: 'array', items: { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false } });
const REFINE_SCHEMA = {
  type: 'object',
  properties: {
    n: intItems({ i: { type: 'integer' }, s: { type: 'string' } }),
    p: intItems({ t: { type: 'integer' }, i: { type: 'integer' } }),
    g: intItems({ s: { type: 'string' }, t: { type: 'array', items: { type: 'integer' } } }),
    m: intItems({ a: { type: 'integer' }, b: { type: 'integer' } }),
    h: intItems({ s: { type: 'string' }, k: { type: 'string', enum: [...AI_HINTS, 'none'] } }),
  },
  required: ['n', 'p', 'g', 'm', 'h'],
  additionalProperties: false,
};
const REFINE_MAX_TOKENS = 700;

// ---------- reading the answer, safely ----------

// -> { names: Map(groupId -> name), place: Map(tabId -> groupId), groups: [{ name, ids }], merges: [[into, from]],
// hints: Map(host -> hint | 'none') } or null when it is not an object. Anything unknown, repeated or out of
// range is dropped; a host that was asked about (hosts) and left out of the answer counts as "none".
function parseRefinement(json, { groupIds, leftoverIds, hosts = [] }) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const G = groupIds instanceof Set ? groupIds : new Set(groupIds);
  const L = leftoverIds instanceof Set ? leftoverIds : new Set(leftoverIds);
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const int = (v) => (Number.isInteger(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const plan = { names: new Map(), place: new Map(), groups: [], merges: [], hints: new Map() };
  const asked = new Set(hosts);
  for (const { s, k } of list(json.h)) {
    const host = String(s || '').trim().toLowerCase().replace(/^www\./, '');
    if (asked.has(host) && !plan.hints.has(host)) plan.hints.set(host, AI_HINTS.includes(k) ? k : 'none');
  }
  for (const host of asked) if (!plan.hints.has(host)) plan.hints.set(host, 'none');
  for (const { i, s } of list(json.n)) {
    const id = int(i);
    const name = tg.cleanGroupName(s);
    if (G.has(id) && name && !plan.names.has(id)) plan.names.set(id, name);
  }
  const merged = new Set();
  const into = new Set();
  for (const { a, b } of list(json.m)) {
    const x = int(a);
    const y = int(b);
    if (x === y || !G.has(x) || !G.has(y) || merged.has(y) || merged.has(x) || into.has(y)) continue;
    merged.add(y);
    into.add(x);
    plan.merges.push([x, y]);
    if (plan.merges.length >= 10) break;
  }
  const used = new Set();
  for (const { t, i } of list(json.p)) {
    const tab = int(t);
    const group = int(i);
    if (L.has(tab) && G.has(group) && !used.has(tab)) { plan.place.set(tab, group); used.add(tab); }
  }
  for (const { s, t } of list(json.g)) {
    const name = tg.cleanGroupName(s);
    const ids = [];
    for (const raw of Array.isArray(t) ? t : []) { const id = int(raw); if (L.has(id) && !used.has(id) && !ids.includes(id)) ids.push(id); }
    if (!name || ids.length < 2) continue;
    ids.forEach((id) => used.add(id));
    plan.groups.push({ name, ids });
    if (plan.groups.length >= 6) break;
  }
  return plan;
}

// ---------- is the local result already good? ----------

// A leftover worth asking about: a page with a real title (not a login wall or a loading screen) on
// a site that is not an app or a search engine, with at least two informative words.
function askable(e) {
  if (tg.isTransientTitle(e.title) || tg.isAppOrSearch(e.url)) return false;
  return tg.tokens(tg.stripSiteSegment(e.title || '', e.url || '')).length >= 2;
}

function clearName(g) {
  const name = String(g.name || '').trim();
  const words = name.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3 || GENERIC_NAMES.has(name.toLowerCase())) return false;
  if (words.some((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length < 2)) return false;
  return g.cohesion == null || g.cohesion >= MIN_COHESION;
}

// Two groups that look like pieces of one topic (they share a top word, or most of one's hosts are
// the other's): worth asking the model whether to merge them.
function fragments(groups) {
  const own = groups.filter((g) => !g.userNamed && g.entries?.length);
  const words = own.map((g) => new Set(topWords(g.entries, 6)));
  const hosts = own.map((g) => hostCounts(g.entries).slice(0, 3));
  const out = [];
  for (let i = 0; i < own.length; i++) for (let j = i + 1; j < own.length; j++) {
    const sharedWord = [...words[i]].some((w) => w.length > 3 && words[j].has(w));
    const sharedHosts = hosts[i].filter((h) => hosts[j].includes(h) && !tg.isAppOrSearch(`https://${h}/`)).length >= 2;
    if (sharedWord || sharedHosts) out.push([own[i].id, own[j].id]);
  }
  return out;
}

function assess(view) {
  const left = view.leftovers.filter(askable);
  const vague = view.groups.filter((g) => !clearName(g));
  const split = fragments(view.groups);
  return { needsAi: left.length > 0 || vague.length > 0 || split.length > 0, askableLeftovers: left, vagueGroups: vague, fragments: split };
}

// ---------- remembering answers ----------

// In memory, per run of Lumen: what the model said about a group (by its members) or a leftover tab.
// The same tabs organized again are answered from here; changed tabs alone go to the model.
function createRefineCache(max = 500) {
  const names = new Map(); // groupKey -> name | null (asked, no better name)
  const place = new Map(); // tabKey -> { g: groupKey|null, n: new group name|null, mates: [tabKey] }
  const merges = new Set(); // `${groupKeyInto}|${groupKeyFrom}`
  const trim = (m) => { while (m.size > max) m.delete(m.keys().next().value); };
  return {
    names, place, merges,
    // Splits the view into what the cache answers (as a plan in the view's own ids) and what is still open.
    lookup(view) {
      const plan = { names: new Map(), place: new Map(), groups: [], merges: [] };
      const byKey = new Map(view.groups.map((g) => [groupKey(g.entries), g]));
      const pendingGroups = [];
      for (const g of view.groups) {
        const key = groupKey(g.entries);
        if (!names.has(key)) { pendingGroups.push(g); continue; }
        const name = names.get(key);
        if (name && name !== g.name) plan.names.set(g.id, name);
      }
      for (const [ka, kb] of [...merges].map((m) => m.split('|'))) if (byKey.has(ka) && byKey.has(kb)) plan.merges.push([byKey.get(ka).id, byKey.get(kb).id]);
      const pendingLeft = [];
      const byTab = new Map(view.leftovers.map((e) => [tabKey(e), e]));
      const made = new Set();
      for (const e of view.leftovers) {
        const hit = place.get(tabKey(e));
        if (!hit) { pendingLeft.push(e); continue; }
        if (hit.g && byKey.has(hit.g)) plan.place.set(e.id, byKey.get(hit.g).id);
        else if (hit.n && !made.has(hit.n) && hit.mates.every((k) => byTab.has(k))) {
          made.add(hit.n);
          plan.groups.push({ name: hit.n, ids: hit.mates.map((k) => byTab.get(k).id) });
        }
      }
      return { plan, pending: { groups: pendingGroups, leftovers: pendingLeft } };
    },
    // What the model was asked (sent) and what it answered (plan), kept by stable keys.
    remember(view, sent, plan) {
      const key = new Map(view.groups.map((g) => [g.id, groupKey(g.entries)]));
      const tab = new Map(view.leftovers.map((e) => [e.id, tabKey(e)]));
      for (const g of sent.groups) names.set(key.get(g.id), plan.names.get(g.id) ?? null);
      for (const [a, b] of plan.merges) merges.add(`${key.get(a)}|${key.get(b)}`);
      const inGroup = new Set();
      for (const grp of plan.groups) { const mates = grp.ids.map((id) => tab.get(id)); mates.forEach((k, i) => { inGroup.add(grp.ids[i]); place.set(k, { g: null, n: grp.name, mates }); }); }
      for (const [t, g] of plan.place) { place.set(tab.get(t), { g: key.get(g), n: null, mates: [] }); inGroup.add(t); }
      for (const e of sent.leftovers) if (!inGroup.has(e.id)) place.set(tab.get(e.id), { g: null, n: null, mates: [] });
      trim(names); trim(place); trim(merges);
    },
    clear() { names.clear(); place.clear(); merges.clear(); },
  };
}

// ---------- chunking very large sessions ----------

// One request per chunk, at most maxChunks, each holding whole groups and the leftovers of the hosts
// its groups have. Merges only make sense inside a chunk.
function chunkView(view, { tabs = 0, maxChunks = MAX_PARALLEL, items = CHUNK_ITEMS } = {}) {
  const total = view.groups.length + view.leftovers.length;
  if (tabs <= CHUNK_ABOVE_TABS || total <= items) return [view];
  const n = Math.min(maxChunks, Math.ceil(total / items));
  const primary = (g) => hostCounts(g.entries)[0] || '';
  const groups = [...view.groups].sort((a, b) => primary(a).localeCompare(primary(b)) || a.id - b.id);
  const chunks = Array.from({ length: n }, () => ({ groups: [], leftovers: [] }));
  const per = Math.ceil(groups.length / n);
  groups.forEach((g, i) => chunks[Math.min(n - 1, Math.floor(i / per))].groups.push(g));
  const home = new Map();
  chunks.forEach((c, ci) => c.groups.forEach((g) => hostCounts(g.entries).forEach((h) => { if (!home.has(h)) home.set(h, ci); })));
  let rr = 0;
  for (const e of view.leftovers) chunks[home.get(hostOf(e.url)) ?? (rr++ % n)].leftovers.push(e);
  return chunks.filter((c) => c.groups.length || c.leftovers.length);
}

// ---------- applying an answer without reflowing the strip ----------

// The operations a plan comes to, given the groups that exist: renames in place, tabs from the
// leftovers into existing groups (never a tab that is already in a group), new groups from leftovers,
// merges. A tab placed into a group that gets merged goes to the group it merged into. No-ops dropped.
function planApply(view, plan) {
  const nameOf = new Map(view.groups.map((g) => [g.id, g.name]));
  const mergedInto = new Map(plan.merges.map(([a, b]) => [b, a]));
  const target = (id) => mergedInto.get(id) ?? id;
  const renames = [];
  for (const [id, name] of plan.names) {
    const dest = target(id);
    if (mergedInto.has(id)) continue; // the group is going away
    if (nameOf.get(dest) && name.toLowerCase() !== nameOf.get(dest).toLowerCase()) renames.push({ id: dest, name });
  }
  const leftover = new Set(view.leftovers.map((e) => e.id));
  const places = [...plan.place].filter(([t]) => leftover.has(t)).map(([tab, g]) => ({ tab, group: target(g) }));
  const groups = plan.groups.map((g) => ({ name: g.name, ids: g.ids.filter((id) => leftover.has(id) && !places.some((p) => p.tab === id)) })).filter((g) => g.ids.length >= 2);
  return { renames, places, groups, merges: plan.merges.map(([into, from]) => ({ into, from })), empty: !renames.length && !places.length && !groups.length && !plan.merges.length };
}

// Combines the plans of several chunks (their ids never overlap).
function mergePlans(plans) {
  const out = { names: new Map(), place: new Map(), groups: [], merges: [] };
  for (const p of plans) {
    if (!p) continue;
    for (const [k, v] of p.names) out.names.set(k, v);
    for (const [k, v] of p.place) out.place.set(k, v);
    out.groups.push(...p.groups);
    out.merges.push(...p.merges);
  }
  return out;
}

function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('The model took too long.'), { code: 'timeout' })), ms);
    const onAbort = () => reject(Object.assign(new Error('Cancelled.'), { code: 'cancelled' }));
    if (signal?.aborted) { clearTimeout(timer); reject(Object.assign(new Error('Cancelled.'), { code: 'cancelled' })); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); });
  });
}

// Runs items through fn, at most `limit` at a time.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---------- the whole thing ----------

// tabGroups: createTabGroups() (organizeByTopic, organizeView, applyRefinement, organizeSeq).
// ask(wire, { signal }) -> the model's JSON. Phase 1 (local, one step of undo) is applied before any
// request; phase 2 renames / places / merges in place, guarded so it can't undo the user's own edits.
// Every failure keeps the local result. onPhase(name, info): 'local' | 'asking' | 'refined' | 'done'.
// hints (optional): { lookup(url) -> hint | '' | undefined, learn(Map host -> hint) }, the learner's aiHint
// and learnAiHints. Sites no hint is known for ride along in the same request (q, host names only), and
// what the model says they are for is kept for next time and for local grouping; with nothing else to
// ask, a request with only those hosts is made. A failed or late answer teaches nothing.
async function organizeProgressive({ tabGroups, ask, cache = createRefineCache(), onPhase = () => {}, signal, timeoutMs = TIMEOUT_MS, now = Date.now, maxTabs = 400, skipId = () => false, alwaysAsk = false, hints = null } = {}) {
  const t0 = now();
  const stats = { groups: 0, aiUsed: false, reason: '', cached: false, requests: 0, chunks: 0, failed: '', wire: [], renamed: 0, placed: 0, created: 0, merged: 0, hinted: 0, localMs: 0, totalMs: 0 };
  const count = tabGroups.organizeByTopic(null);
  const seq = tabGroups.organizeSeq();
  stats.groups = count;
  stats.localMs = now() - t0;
  onPhase('local', { count });
  const view = tabGroups.organizeView();
  // Tabs on sites where the user turned AI off are never described to a model.
  view.groups = view.groups.map((g) => ({ ...g, entries: g.entries.filter((e) => !skipId(e.id)) })).filter((g) => g.entries.length);
  view.leftovers = view.leftovers.filter((e) => !skipId(e.id)).slice(0, maxTabs);
  const tabs = view.groups.reduce((n, g) => n + g.entries.length, 0) + view.leftovers.length;
  const finish = (reason) => {
    stats.reason = reason;
    stats.totalMs = now() - t0;
    try { const after = tabGroups.organizeView(); stats.finalGroups = after.groups.length; stats.loose = after.leftovers.length; } catch { /* a stub without organizeView */ }
    onPhase('done', stats);
    return stats;
  };
  if (signal?.aborted) return finish('cancelled');
  const hosts = hints ? unknownHosts([...view.groups.flatMap((g) => g.entries), ...view.leftovers], hints.lookup) : [];
  const learnHints = (plan) => { if (hints && plan?.hints?.size) stats.hinted += hints.learn(plan.hints) || 0; };
  // Only the unknown sites to ask about: one small request, the groups stay as they are.
  const askHostsOnly = async () => {
    if (!hosts.length) return;
    const wire = buildWire({ groups: [], leftovers: [] }, hosts);
    stats.requests++;
    stats.wire.push(JSON.stringify(wire));
    try {
      learnHints(parseRefinement(await withTimeout(Promise.resolve(ask(wire, { signal })), timeoutMs, signal), { groupIds: [], leftoverIds: [], hosts }));
    } catch (err) { stats.failed = err.code || err.message || 'failed'; }
  };

  const { plan: cachedPlan, pending } = cache.lookup(view);
  const need = alwaysAsk ? { needsAi: true, askableLeftovers: pending.leftovers } : assess({ groups: pending.groups, leftovers: pending.leftovers });
  const cachedEmpty = !cachedPlan.names.size && !cachedPlan.place.size && !cachedPlan.groups.length && !cachedPlan.merges.length;
  const applyPlan = (plan) => {
    const ops = planApply(view, plan);
    if (ops.empty) return;
    onPhase('refined', ops);
    const res = tabGroups.applyRefinement(ops, { seq });
    stats.renamed = res.renamed; stats.placed = res.placed; stats.created = res.created; stats.merged = res.merged;
  };

  if (!need.needsAi) {
    stats.cached = !cachedEmpty;
    if (!cachedEmpty) applyPlan(cachedPlan);
    await askHostsOnly();
    return finish(signal?.aborted ? 'cancelled' : cachedEmpty ? 'confident' : 'cached');
  }

  const sendView = { groups: pending.groups.length ? pending.groups : [], leftovers: need.askableLeftovers };
  // Groups already named well are only context for placing leftovers: keep them small but present.
  const context = view.groups.filter((g) => !pending.groups.includes(g));
  if (sendView.leftovers.length && context.length) sendView.groups = [...sendView.groups, ...context.map((g) => ({ ...g, ctx: true }))]; // already named: only their words are context
  if (!sendView.groups.length && !sendView.leftovers.length) { stats.cached = !cachedEmpty; if (!cachedEmpty) applyPlan(cachedPlan); await askHostsOnly(); return finish(signal?.aborted ? 'cancelled' : 'cached'); }
  const chunks = chunkView(sendView, { tabs });
  stats.aiUsed = true;
  stats.chunks = chunks.length;
  onPhase('asking', { chunks: chunks.length });
  const plans = [];
  let failure = '';
  await pool(chunks, MAX_PARALLEL, async (chunk, ci) => {
    const asked = ci === 0 ? hosts : []; // the unknown sites ride along with the first request only
    const wire = buildWire(chunk, asked);
    stats.requests++;
    stats.wire.push(JSON.stringify(wire));
    try {
      const json = await withTimeout(Promise.resolve(ask(wire, { signal })), timeoutMs, signal);
      const parsed = parseRefinement(json, { groupIds: chunk.groups.map((g) => g.id), leftoverIds: chunk.leftovers.map((e) => e.id), hosts: asked });
      if (!parsed) throw new Error('Unusable answer.');
      cache.remember(view, chunk, parsed);
      learnHints(parsed);
      plans.push(parsed);
    } catch (err) {
      failure = failure || err.code || err.message || 'failed';
    }
  });
  stats.failed = failure;
  if (signal?.aborted) return finish('cancelled');
  const combined = mergePlans([cachedPlan, ...plans]);
  applyPlan(combined);
  return finish(failure && !plans.length ? `kept local (${failure})` : 'refined');
}

module.exports = {
  hostOf, tabKey, groupKey, setKey, estimateTokens, topWords, groupSummary, leftoverSummary, buildWire, legacyWire, unknownHosts, MAX_HINT_HOSTS,
  REFINE_PROMPT, REFINE_SCHEMA, REFINE_MAX_TOKENS, parseRefinement, askable, clearName, assess, createRefineCache, chunkView,
  planApply, mergePlans, fragments, withTimeout, organizeProgressive, TIMEOUT_MS, MAX_PARALLEL, MIN_COHESION,
};
