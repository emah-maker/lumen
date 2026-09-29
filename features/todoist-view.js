// What a Todoist widget shows: its per-widget settings (validated), the question it asks Todoist
// (a filter query or a project), and how the answer is sorted, grouped and cut to fit. Pure
// functions, no network and no Electron: features/widgets.js does the fetching, and the tests
// exercise all of this on its own.
'use strict';

const SOURCES = ['todayOverdue', 'today', 'upcoming', 'inbox', 'project', 'label', 'all', 'custom'];
const GROUPS = ['none', 'project', 'due', 'priority', 'label'];
const SORTS = ['due', 'priority', 'project', 'manual', 'created'];
const DENSITIES = ['comfortable', 'compact'];
const MAXES = [5, 10, 20, 50, 0]; // 0: all of them, the card scrolls
const QUICK = ['off', 'top', 'bottom'];
const FIELDS = ['due', 'project', 'labels', 'priority', 'description', 'subtasks', 'recurring'];
const DEFAULT_FIELDS = { due: true, project: false, labels: false, priority: true, description: false, subtasks: false, recurring: true };
const MAX_QUERY = 200;
const FETCH_LIMIT = 150; // tasks read from Todoist per refresh, before sorting and cutting
const PRIORITY_LABELS = { 4: 'Priority 1', 3: 'Priority 2', 2: 'Priority 3', 1: 'No priority' };

const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const flat = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const int = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Math.round(Number(v)) : fallback);
const idOf = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const ID = /^[\w-]{1,40}$/;

// The stored (or form) config -> a complete, checked one. Anything missing or wrong falls back to
// what an older Todoist widget did: today and overdue tasks, comfortably, ten of them.
function cleanConfig(c) {
  const i = c && typeof c === 'object' ? c : {};
  const f = i.fields && typeof i.fields === 'object' ? i.fields : {};
  const out = {
    source: pick(i.source, SOURCES, 'todayOverdue'),
    days: int(i.days, 1, 30, 7),
    projectId: ID.test(idOf(i.projectId)) ? idOf(i.projectId) : '',
    projectName: flat(i.projectName, 80),
    label: flat(i.label, 60).replace(/^@/, '').replace(/\s/g, '_'),
    query: flat(i.query, MAX_QUERY),
    group: pick(i.group, GROUPS, 'none'),
    sort: pick(i.sort, SORTS, 'due'),
    fields: Object.fromEntries(FIELDS.map((k) => [k, typeof f[k] === 'boolean' ? f[k] : DEFAULT_FIELDS[k]])),
    density: pick(i.density, DENSITIES, 'comfortable'),
    max: MAXES.includes(i.max) ? i.max : 10,
    showDone: i.showDone === true,
    overdueRed: i.overdueRed !== false,
    showCount: i.showCount === true,
    quick: pick(i.quick, QUICK, 'off'),
    quickProjectId: ID.test(idOf(i.quickProjectId)) ? idOf(i.quickProjectId) : '',
  };
  // A source that needs a value it doesn't have is the default source.
  if ((out.source === 'project' && !out.projectId) || (out.source === 'label' && !out.label) || (out.source === 'custom' && !out.query)) out.source = 'todayOverdue';
  return out;
}

// What to ask Todoist: a filter query, or (for a project) its id. Todoist's own filter language.
function questionFor(cfg) {
  switch (cfg.source) {
    case 'today': return { query: 'today' };
    case 'upcoming': return { query: `${cfg.days} days` };
    case 'inbox': return { query: '#Inbox' };
    case 'project': return { projectId: cfg.projectId };
    case 'label': return { query: `@${cfg.label}` };
    case 'all': return { query: 'view all' };
    case 'custom': return { query: cfg.query };
    default: return { query: 'today | overdue' };
  }
}
const nameFor = (cfg) => ({
  todayOverdue: 'Today', today: 'Today', upcoming: `Next ${cfg.days} days`, inbox: 'Inbox', project: cfg.projectName || 'Project',
  label: `@${cfg.label}`, all: 'All tasks', custom: 'Filter',
}[cfg.source]);
const summaryFor = (cfg) => ({
  todayOverdue: 'Today and overdue tasks', today: 'Tasks due today', upcoming: `Tasks due in the next ${cfg.days} days`, inbox: 'Inbox',
  project: `Project: ${cfg.projectName || cfg.projectId}`, label: `Label: @${cfg.label}`, all: 'All tasks', custom: `Filter: ${cfg.query}`,
}[cfg.source]);

// ---- Todoist's colours: a fixed table, so nothing from the network is ever a style ----
const COLORS = {
  berry_red: '#b8255f', red: '#db4035', orange: '#ff9933', yellow: '#fad000', olive_green: '#afb83b', lime_green: '#7ecc49', green: '#299438',
  mint_green: '#6accbc', teal: '#158fad', sky_blue: '#14aaf5', light_blue: '#96c3eb', blue: '#4073ff', grape: '#884dff', violet: '#af38eb',
  lavender: '#eb96eb', magenta: '#e05194', salmon: '#ff8d85', charcoal: '#808080', grey: '#b8b8b8', gray: '#b8b8b8', taupe: '#ccac93',
};
const colorOf = (name) => (typeof name === 'string' && COLORS[name.toLowerCase()]) || (typeof name === 'string' && /^#[0-9a-f]{6}$/i.test(name) ? name.toLowerCase() : null);

// ---- dates ----
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayNumber = (s) => { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400e3); };

// One task from Todoist -> the checked fields the page may show, or null. projects: id -> { name, color }.
function normalizeTask(t, projects = new Map(), today = ymd(new Date())) {
  if (!t || typeof t !== 'object' || !ID.test(idOf(t.id))) return null;
  const id = idOf(t.id);
  const due = t.due && typeof t.due === 'object' ? t.due : null;
  const when = flat(due?.datetime || due?.date, 30);
  const date = when.slice(0, 10);
  const time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?$/.test(when) ? when : null;
  const project = projects.get(idOf(t.project_id)) || null;
  const created = Date.parse(t.added_at || t.created_at || '');
  return {
    id,
    title: flat(t.content, 300) || 'Untitled task',
    description: flat(t.description, 200),
    due: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    time,
    overdue: /^\d{4}-\d{2}-\d{2}$/.test(date) && date < today,
    priority: pick(t.priority, [1, 2, 3, 4], 1), // 4 is Todoist's p1 (urgent)
    url: `https://app.todoist.com/app/task/${id}`,
    projectId: ID.test(idOf(t.project_id)) ? idOf(t.project_id) : '',
    project: project ? { name: flat(project.name, 60), color: colorOf(project.color) } : null,
    labels: (Array.isArray(t.labels) ? t.labels : []).map((l) => flat(l, 40)).filter(Boolean).slice(0, 6),
    parent: ID.test(idOf(t.parent_id)) ? idOf(t.parent_id) : '',
    recurring: due?.is_recurring === true,
    order: Number.isFinite(t.child_order) ? t.child_order : Number.isFinite(t.order) ? t.order : 0,
    created: Number.isFinite(created) ? created : 0,
  };
}

// ---- sort, group, cut ----
const dueKey = (t) => (t.due ? `${t.due}${t.time ? t.time.slice(10) : 'T99'}` : '9999');
const byDue = (a, b) => dueKey(a).localeCompare(dueKey(b)) || b.priority - a.priority;
function sortTasks(tasks, sort) {
  const list = tasks.map((t, i) => [t, i]);
  const cmp = {
    due: (a, b) => byDue(a, b),
    priority: (a, b) => b.priority - a.priority || byDue(a, b),
    project: (a, b) => (a.project?.name || '￿').localeCompare(b.project?.name || '￿') || byDue(a, b),
    manual: (a, b) => a.order - b.order,
    created: (a, b) => a.created - b.created,
  }[pick(sort, SORTS, 'due')];
  return list.sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]).map((p) => p[0]);
}
const BUCKETS = ['Overdue', 'Today', 'Tomorrow', 'This week', 'Later', 'No date'];
function bucketOf(t, today) {
  if (!t.due) return 'No date';
  const days = dayNumber(t.due) - dayNumber(today);
  return days < 0 ? 'Overdue' : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days <= 7 ? 'This week' : 'Later';
}
// [{ key, label, tasks }] in a sensible order for the grouping; tasks keep their sorted order.
function groupTasks(tasks, group, today = ymd(new Date())) {
  if (group === 'none' || !GROUPS.includes(group)) return [{ key: '', label: '', tasks }];
  const map = new Map();
  const add = (key, label, t) => { if (!map.has(key)) map.set(key, { key, label, tasks: [] }); map.get(key).tasks.push(t); };
  for (const t of tasks) {
    if (group === 'project') add(t.projectId || '-', t.project?.name || 'No project', t);
    else if (group === 'due') add(bucketOf(t, today), bucketOf(t, today), t);
    else if (group === 'priority') add(String(t.priority), PRIORITY_LABELS[t.priority], t);
    else if (t.labels.length) for (const l of t.labels) add(`l:${l}`, `@${l}`, t);
    else add('-', 'No label', t);
  }
  const groups = [...map.values()];
  if (group === 'due') groups.sort((a, b) => BUCKETS.indexOf(a.key) - BUCKETS.indexOf(b.key));
  else if (group === 'priority') groups.sort((a, b) => Number(b.key) - Number(a.key));
  else groups.sort((a, b) => (a.key.startsWith('-') ? 1 : 0) - (b.key.startsWith('-') ? 1 : 0) || a.label.localeCompare(b.label));
  return groups;
}
// Cut to `max` tasks across the groups (0: no cut); empty groups go.
function limitTasks(groups, max) {
  let left = max > 0 ? max : Infinity;
  const out = [];
  let shown = 0;
  for (const g of groups) {
    if (left <= 0) break;
    const tasks = g.tasks.slice(0, left);
    left -= tasks.length;
    shown += tasks.length;
    if (tasks.length) out.push({ ...g, tasks, more: g.tasks.length - tasks.length });
  }
  return { groups: out, shown };
}
// The fields the config hides never leave the main process.
function present(t, cfg) {
  const f = cfg.fields;
  const out = { id: t.id, title: t.title, url: t.url, overdue: t.overdue };
  if (f.due) { out.due = t.due; out.time = t.time; }
  if (f.priority) out.priority = t.priority;
  if (f.project && t.project) out.project = t.project;
  if (f.labels && t.labels.length) out.labels = t.labels.slice(0, 3);
  if (f.description && t.description) out.description = t.description.slice(0, 120);
  if (f.subtasks && t.subtasks) out.subtasks = t.subtasks;
  if (f.recurring && t.recurring) out.recurring = true;
  return out;
}
// Tasks (normalized) + config -> what the card shows: { name, total, shown, groups: [{ label, tasks, more }] }.
function shape(tasks, cfg, today = ymd(new Date())) {
  const counts = new Map();
  for (const t of tasks) if (t.parent) counts.set(t.parent, (counts.get(t.parent) || 0) + 1);
  const withSubs = tasks.map((t) => (counts.has(t.id) ? { ...t, subtasks: counts.get(t.id) } : t));
  const grouped = groupTasks(sortTasks(withSubs, cfg.sort), cfg.group, today);
  const { groups, shown } = limitTasks(grouped, cfg.max);
  return {
    name: nameFor(cfg), total: tasks.length, shown,
    groups: groups.map((g) => ({ label: g.label, more: g.more, tasks: g.tasks.map((t) => present(t, cfg)) })),
  };
}

module.exports = {
  SOURCES, GROUPS, SORTS, DENSITIES, MAXES, QUICK, FIELDS, DEFAULT_FIELDS, FETCH_LIMIT, MAX_QUERY, COLORS,
  cleanConfig, questionFor, nameFor, summaryFor, colorOf, normalizeTask, sortTasks, groupTasks, limitTasks, shape, ymd, bucketOf,
};
