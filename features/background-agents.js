// Background agent tasks: the pure part (no Electron, unit-tested in test/units.js). A Task is a job
// the AI does on its own while the user keeps browsing: run now, at a time, every N minutes, or
// "watch a page and tell me when X". This file holds the task model, how a task's allowed sites are
// derived, schedule math, the run queue, page-watch change detection, the state machine (including
// what a restart does to a task that was running) and the on-disk store. features/background-runner.js
// runs tasks (work tab, agent loop, approvals, IPC).
//
// Stored like saved chats (features/chat-store.js): one file, encrypted with the OS keychain, and with
// no keychain nothing is written (results can hold page data). Written atomically, capped at 50 tasks.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tlds = require('../tlds');
const { describeUsage, addUsage } = require('./chat-usage');

const LIMITS = { tasks: 50, steps: 200, runs: 10, result: 24000, title: 80, prompt: 8000, condition: 300, sites: 20 };
const STATUSES = ['queued', 'running', 'waiting-approval', 'done', 'failed', 'stopped', 'interrupted'];
const ACTIVE = new Set(['queued', 'running', 'waiting-approval']);
const OCCUPYING = new Set(['running', 'waiting-approval']); // hold a concurrency slot (and a work tab)
const TRANSITIONS = {
  queued: ['running', 'stopped', 'failed'],
  running: ['waiting-approval', 'done', 'failed', 'stopped', 'interrupted'],
  'waiting-approval': ['running', 'done', 'failed', 'stopped', 'interrupted'],
  done: ['queued'], failed: ['queued'], stopped: ['queued'], interrupted: ['queued'],
};
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

const DEFAULT_SETTINGS = { enabled: true, maxConcurrent: 2, notifications: true, timeoutMin: 30 };
const TIMEOUT_CHOICES = [10, 30, 60, 120];
const BACKGROUND_STEPS = 60; // Max steps per task when the setting is Unlimited: an unattended run always ends

function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const mc = Math.round(Number(s.maxConcurrent));
  const to = Number(s.timeoutMin);
  return {
    enabled: s.enabled !== false,
    maxConcurrent: Number.isFinite(mc) ? Math.min(3, Math.max(1, mc)) : DEFAULT_SETTINGS.maxConcurrent,
    notifications: s.notifications !== false,
    timeoutMin: TIMEOUT_CHOICES.includes(to) ? to : DEFAULT_SETTINGS.timeoutMin,
  };
}

// The step limit a background run gets: the user's Max steps setting, or 60 when it is Unlimited.
const backgroundStepLimit = (setting) => (Number.isInteger(setting) && setting > 0 ? Math.min(setting, 1000) : BACKGROUND_STEPS);

// ---- models and engines. A task runs on an API model, or on the user's own Claude Code / Grok Build CLI.

const CLI_ENGINES = { claudecode: 'Claude Code', grokbuild: 'Grok Build' };
const engineOfModel = (model) => /^claudecode:/.test(String(model)) ? 'claudecode' : /^grokbuild:/.test(String(model)) ? 'grokbuild' : 'api';
const isCliModel = (model) => engineOfModel(model) !== 'api';

// The models a task may use, from the picker's options: every connected API model (chat-only ones can't
// act, so no) and each CLI model. A CLI model of a CLI that is not signed in is listed but not available.
function taskModels(options) {
  return (options || []).filter((o) => o && o.id && o.id !== 'openrouter:__more' && !/chat only/i.test(o.label || '')).map((o) => {
    const engine = engineOfModel(o.id);
    return { id: o.id, label: o.label || o.id, group: o.group || '', engine, available: engine === 'api' || o.signedIn !== false };
  });
}

// Why a CLI model can't run a task right now, or null. cli: aiAgents.cliStatus(). The key is a locale
// key (tasks.error.cli*), the params fill it. 'unknown' sign-in is allowed: the run itself reports it.
function cliProblem(model, cli) {
  const engine = engineOfModel(model);
  if (engine === 'api') return null;
  const c = (cli || {})[engine];
  const params = { name: CLI_ENGINES[engine] };
  if (!c || !c.installed || c.enabled === false) return { key: 'tasks.error.cliMissing', params };
  if (c.signedIn === false) return { key: 'tasks.error.cliSignedOut', params };
  return null;
}

// The state of each CLI for the create card's note: 'ready', 'not-installed' or 'not-signed-in'.
function cliStates(cli) {
  return Object.keys(CLI_ENGINES).map((engine) => {
    const p = cliProblem(`${engine}:default`, cli);
    return { engine, name: CLI_ENGINES[engine], state: !p ? 'ready' : p.key === 'tasks.error.cliSignedOut' ? 'not-signed-in' : 'not-installed' };
  });
}

// --max-turns for a CLI run (the same limit an API run gets from its step budget; a watch check's judge is short).
const cliMaxTurns = (setting, kind = 'run') => (kind === 'judge' ? 8 : backgroundStepLimit(setting));

// The task's usage after a CLI run: its tokens (usageOf's shape, as the API's) and the list-price cost the
// CLI reported. null when the run reported neither (a failure before any turn).
function cliTaskUsage(prev, out, model) {
  const u = out?.usage;
  if (!u && typeof out?.cost !== 'number') return null;
  const raw = u ? { input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_creation_input_tokens: u.cacheWriteTokens, cache_read_input_tokens: u.cacheReadTokens } : null;
  return addUsage(prev, { model, usage: raw, cost: typeof out.cost === 'number' ? out.cost : u?.costUSD });
}

// What a finished CLI run adds to the usage log (features/usage.js record): tagged background, so those
// records stay apart from the sidebar's (its context bar, its Claude 5-hour share).
const cliUsageReport = (out, model) => ({ usage: out?.usage || null, rateLimit: out?.rateLimit || null, model: String(model || 'default'), background: true });

// ---- allowed sites

function hostOfUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host.toLowerCase() : '';
  } catch { return ''; }
}

// A prompt word as a host: a URL, or a bare domain whose ending is a real top-level domain
// ("example.com/path" yes, "notes.txt" and "index.js" no), localhost or an IP address.
function hostFromToken(token) {
  let t = String(token).replace(/^[("'“‘<[]+/, '').replace(/[)"'”’>\],.;:!?]+$/, '');
  if (!t || t.includes('@')) return '';
  if (/^https?:\/\//i.test(t)) return hostOfUrl(t);
  t = t.replace(/[/?#].*$/, '');
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/i.test(t)) return t.toLowerCase();
  const m = /^((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z][a-z0-9-]*))(:\d+)?$/i.exec(t);
  return m && tlds.has(m[2].toLowerCase()) ? `${m[1]}${m[3] || ''}`.toLowerCase() : '';
}

const hostsInText = (text) => [...new Set(String(text || '').split(/\s+/).map(hostFromToken).filter(Boolean))];

// example.com and www.example.com are the same place to a person; anything else (other subdomains,
// other domains) is not covered.
function withWww(host) {
  if (!host || /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/.test(host)) return [host];
  return host.startsWith('www.') ? [host, host.slice(4)] : [host, `www.${host}`];
}

// The sites a new task may visit without asking: hosts named in its prompt, plus the tab the user
// was on when they made it (`pageUrl`). `extra` is what the user typed in the dialog.
function allowedSitesFor(prompt, pageUrl = '', extra = []) {
  const hosts = [...hostsInText(prompt), hostOfUrl(pageUrl), ...extra.map((e) => hostFromToken(e))].filter(Boolean);
  return [...new Set(hosts.flatMap(withWww))].slice(0, LIMITS.sites);
}

// ---- schedules

function normalizeSchedule(raw, now = Date.now()) {
  const s = raw && typeof raw === 'object' ? raw : { type: 'now' };
  if (s.type === 'now') return { type: 'now' };
  if (s.type === 'at') {
    const at = typeof s.at === 'number' ? s.at : Date.parse(s.at);
    if (!Number.isFinite(at)) throw new Error('Pick a valid time.');
    return { type: 'at', at: Math.round(at) };
  }
  if (s.type === 'every') {
    const minutes = Math.round(Number(s.minutes));
    if (!Number.isFinite(minutes) || minutes < 5) throw new Error('A repeating task needs at least 5 minutes between runs.');
    return { type: 'every', minutes: Math.min(minutes, 60 * 24 * 7) };
  }
  if (s.type === 'watch') {
    if (!hostOfUrl(s.url)) throw new Error('Watching needs a web address (http or https).');
    const minutes = Math.round(Number(s.minutes ?? 15));
    if (!Number.isFinite(minutes) || minutes < 1) throw new Error('Check at most once a minute.');
    return { type: 'watch', url: new URL(s.url).href, condition: String(s.condition || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.condition), minutes: Math.min(minutes, 60 * 24) };
  }
  void now;
  throw new Error('Unknown schedule.');
}

const isRecurring = (schedule) => schedule?.type === 'every' || schedule?.type === 'watch';

// When the task next runs (ms), or null if it never will again. A task that has not run yet is due at
// once (a first run right after creating it; a past 'at', because Lumen was closed then).
function nextRunAt(task) {
  const s = task.schedule;
  if (!s || task.enabled === false) return null;
  if (s.type === 'now') return task.lastRun ? null : task.createdAt;
  if (s.type === 'at') return task.lastRun ? null : s.at;
  if (s.type === 'every' || s.type === 'watch') return task.lastRun ? task.lastRun + s.minutes * 60000 : task.createdAt;
  return null;
}

const isDue = (task, now) => !ACTIVE.has(task.status) && nextRunAt(task) !== null && nextRunAt(task) <= now;

// ---- queue

// Which queued tasks start now: the ones whose time has come (a task queued for 5pm waits), oldest
// first, while there are free slots.
function planStarts(tasks, maxConcurrent, now = Infinity) {
  const busy = tasks.filter((t) => OCCUPYING.has(t.status)).length;
  const free = Math.max(0, maxConcurrent - busy);
  return tasks.filter((t) => t.status === 'queued' && (t.queuedAt || t.createdAt) <= now)
    .sort((a, b) => (a.queuedAt || a.createdAt) - (b.queuedAt || b.createdAt))
    .slice(0, free).map((t) => t.id);
}

// ---- watching a page

const normalizePageText = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200000);
const digest = (text) => crypto.createHash('sha1').update(normalizePageText(text)).digest('hex');

const Q = '["“”\'‘’]';
const CONDITION_PATTERNS = [
  [new RegExp(`^(?:contains?|mentions?|has|shows?|says?)\\s+${Q}(.+?)${Q}$`, 'i'), 'present'],
  [new RegExp(`^${Q}(.+?)${Q}\\s+(?:appears?|shows? up|is (?:shown|present|there|back))$`, 'i'), 'present'],
  [new RegExp(`^(?:no longer (?:contains?|mentions?|shows?)|(?:does not|doesn'?t) (?:contain|mention|show))\\s+${Q}(.+?)${Q}$`, 'i'), 'absent'],
  [new RegExp(`^${Q}(.+?)${Q}\\s+(?:disappears?|is (?:gone|removed))$`, 'i'), 'absent'],
];

// What a watch condition needs: nothing (any change), a text check the app can do itself, or the model.
function parseCondition(condition) {
  const c = String(condition || '').replace(/\s+/g, ' ').trim();
  if (!c) return { kind: 'change' };
  for (const [re, mode] of CONDITION_PATTERNS) {
    const m = re.exec(c);
    if (m && m[1].trim()) return { kind: 'text', needle: m[1].trim(), mode };
  }
  return { kind: 'model', text: c };
}

// One check of a watched page. `prev` is { hash, holding, judgedHash } from the last check. Says what to
// do without calling the model when it can: 'baseline' (first look, remember it), 'unchanged',
// 'notify' (the condition just became true, or the page changed), or 'judge' (ask the model).
function watchDecision(prev, pageText, condition) {
  const p = prev || {};
  const hash = digest(pageText);
  const cond = parseCondition(condition);
  if (cond.kind === 'change') {
    if (!p.hash) return { action: 'baseline', hash, holding: false };
    return p.hash === hash ? { action: 'unchanged', hash, holding: false } : { action: 'notify', hash, holding: false, reason: 'The page changed.' };
  }
  if (cond.kind === 'text') {
    const has = normalizePageText(pageText).toLowerCase().includes(cond.needle.toLowerCase());
    const holds = cond.mode === 'present' ? has : !has;
    if (holds && !p.holding) return { action: 'notify', hash, holding: true, reason: cond.mode === 'present' ? `The page now mentions “${cond.needle}”.` : `The page no longer mentions “${cond.needle}”.` };
    return { action: 'unchanged', hash, holding: holds };
  }
  return p.judgedHash === hash ? { action: 'unchanged', hash, holding: Boolean(p.holding) } : { action: 'judge', hash, holding: Boolean(p.holding) };
}

// The model's verdict on a watch check: its answer starts with MATCH or NO MATCH.
function parseVerdict(text) {
  const first = String(text || '').trim().split('\n')[0].toUpperCase();
  if (/^\W*NO[ _-]?MATCH\b/.test(first)) return { match: false };
  if (/^\W*MATCH\b/.test(first)) return { match: true, reason: String(text).trim().split('\n').slice(1).join(' ').trim().slice(0, 300) || String(text).trim().slice(6).trim() };
  return { match: false, unclear: true };
}

// ---- tasks

const clip = (s, n) => String(s ?? '').slice(0, n);
const cleanLine = (s, n) => clip(String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(), n);
const titleFrom = (prompt) => {
  const line = cleanLine(prompt, 200);
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line || 'Background task';
};
const newTaskId = () => crypto.randomBytes(8).toString('hex');
const ID_RE = /^[a-f0-9]{16}$/;

// A new task from what the dialog collected. Throws with a message for the user when something is off.
function makeTask({ title, prompt, model, schedule, allowedSites, signedIn = false, allowMcp = false, pageUrl = '', now = Date.now(), id = newTaskId() }) {
  const text = clip(String(prompt || '').trim(), LIMITS.prompt);
  const sched = normalizeSchedule(schedule || { type: 'now' }, now);
  if (!text && sched.type !== 'watch') throw new Error('Say what the task should do.');
  if (!model) throw new Error('Pick a model for the task.');
  const sites = Array.isArray(allowedSites) ? allowedSites.map((s) => hostFromToken(s)).filter(Boolean).flatMap(withWww) : allowedSitesFor(text, pageUrl);
  if (sched.type === 'watch') sites.push(...withWww(hostOfUrl(sched.url)));
  const promptText = text || `Watch ${sched.url}${sched.condition ? ` and tell me when: ${sched.condition}` : ' and tell me when it changes'}.`;
  return {
    id,
    title: cleanLine(title, LIMITS.title) || (sched.type === 'watch' ? `Watch ${hostOfUrl(sched.url)}` : titleFrom(promptText)),
    prompt: promptText,
    model: String(model),
    engine: engineOfModel(model),
    schedule: sched,
    allowedSites: [...new Set(sites)].slice(0, LIMITS.sites),
    signedIn: Boolean(signedIn),
    allowMcp: Boolean(allowMcp),
    enabled: true,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    queuedAt: sched.type === 'at' ? sched.at : now,
    lastRun: null,
    steps: [],
    stepCount: 0,
    result: '',
    error: '',
    notice: '',
    usage: null,
    runs: [],
    watch: sched.type === 'watch' ? { hash: null, holding: false, judgedHash: null, checkedAt: null, changedAt: null } : null,
    currentUrl: '',
  };
}

// A saved task, checked field by field (a hand-edited or damaged file must not crash startup). null: unusable.
function sanitizeTask(raw) {
  if (!raw || typeof raw !== 'object' || !ID_RE.test(String(raw.id))) return null;
  let schedule;
  try { schedule = normalizeSchedule(raw.schedule); } catch { return null; }
  const status = STATUSES.includes(raw.status) ? raw.status : 'interrupted';
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).slice(-LIMITS.steps).map((s) => ({
    name: cleanLine(s?.name, 40), label: cleanLine(s?.label, 160), at: num(s?.at), ok: s?.ok === true ? true : s?.ok === false ? false : null, error: cleanLine(s?.error, 160),
  }));
  const runs = (Array.isArray(raw.runs) ? raw.runs : []).slice(-LIMITS.runs).map((r) => ({
    startedAt: num(r?.startedAt), endedAt: num(r?.endedAt), status: STATUSES.includes(r?.status) ? r.status : 'done', summary: cleanLine(r?.summary, 300), cost: r?.cost === null ? null : num(r?.cost), steps: num(r?.steps), kind: r?.kind === 'watch' || r?.kind === 'judge' ? r.kind : 'run',
    ...(typeof r?.session === 'string' && /^[\w-]{1,64}$/.test(r.session) ? { session: r.session } : {}), // a CLI run's own session id (never resumed: see features/background-runner.js)
  }));
  const w = raw.watch && typeof raw.watch === 'object' ? raw.watch : null;
  return {
    id: raw.id,
    title: cleanLine(raw.title, LIMITS.title) || 'Background task',
    prompt: clip(raw.prompt, LIMITS.prompt),
    model: cleanLine(raw.model, 120),
    engine: engineOfModel(raw.model),
    schedule,
    allowedSites: (Array.isArray(raw.allowedSites) ? raw.allowedSites : []).map((s) => cleanLine(s, 120).toLowerCase()).filter(Boolean).slice(0, LIMITS.sites),
    signedIn: raw.signedIn === true,
    allowMcp: raw.allowMcp === true,
    enabled: raw.enabled !== false,
    status,
    createdAt: num(raw.createdAt, Date.now()),
    updatedAt: num(raw.updatedAt, Date.now()),
    queuedAt: num(raw.queuedAt, num(raw.createdAt)),
    lastRun: raw.lastRun === null || raw.lastRun === undefined ? null : num(raw.lastRun),
    steps,
    stepCount: Math.max(num(raw.stepCount), steps.length),
    result: clip(raw.result, LIMITS.result),
    error: cleanLine(raw.error, 300),
    notice: cleanLine(raw.notice, 200),
    usage: raw.usage && typeof raw.usage === 'object' ? raw.usage : null,
    runs,
    watch: schedule.type === 'watch' ? {
      hash: typeof w?.hash === 'string' ? w.hash : null, holding: w?.holding === true, judgedHash: typeof w?.judgedHash === 'string' ? w.judgedHash : null,
      checkedAt: w?.checkedAt ? num(w.checkedAt) : null, changedAt: w?.changedAt ? num(w.changedAt) : null,
    } : null,
    currentUrl: hostOfUrl(raw.currentUrl) ? clip(raw.currentUrl, 500) : '',
  };
}

// What a restart does to a task: one that was running (or waiting on an answer) is 'interrupted', with a
// Retry in the panel; a queued one stays queued. Scheduled tasks keep their schedule.
function recoverAfterRestart(task, now = Date.now()) {
  if (!OCCUPYING.has(task.status)) return task;
  return {
    ...task,
    status: 'interrupted',
    error: 'Lumen closed while this task was running.',
    lastRun: now, // attempted: a scheduled task waits for its next time instead of starting again at once
    updatedAt: now,
    runs: [...task.runs, { startedAt: task.updatedAt, endedAt: now, status: 'interrupted', summary: 'Lumen closed while this task was running.', cost: null, steps: task.stepCount, kind: 'run' }].slice(-LIMITS.runs),
  };
}

// Whether one more task fits: the store keeps 50, dropping the oldest finished one-off tasks first.
// Running, queued and scheduled tasks are never dropped.
const droppable = (t) => !ACTIVE.has(t.status) && !isRecurring(t.schedule);
function fitsAnother(tasks, limit = LIMITS.tasks) {
  return tasks.length < limit || tasks.some(droppable);
}
function capTasks(tasks, limit = LIMITS.tasks) {
  const out = [...tasks];
  while (out.length > limit) {
    const victim = out.filter(droppable).sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!victim) break;
    out.splice(out.indexOf(victim), 1);
  }
  return out;
}

// The list row and badge: no steps or result text.
function summarize(task, now = Date.now(), pending = []) {
  const next = nextRunAt(task);
  return {
    id: task.id, title: task.title, status: task.status, model: task.model, engine: task.engine || engineOfModel(task.model), schedule: task.schedule, enabled: task.enabled,
    lastRun: task.lastRun, nextRun: next && next > now ? next : null, updatedAt: task.updatedAt, createdAt: task.createdAt,
    cost: describeUsage(task.usage), stepCount: task.stepCount, error: task.error, notice: task.notice, allowedSites: task.allowedSites,
    signedIn: task.signedIn, allowMcp: task.allowMcp, currentUrl: task.currentUrl, pending,
    watching: task.watch ? { holding: task.watch.holding, checkedAt: task.watch.checkedAt, changedAt: task.watch.changedAt } : null,
  };
}

// What the toolbar badge counts: tasks running and tasks waiting on the user.
function badgeCounts(tasks) {
  return { running: tasks.filter((t) => t.status === 'running' || t.status === 'queued').length, waiting: tasks.filter((t) => t.status === 'waiting-approval').length };
}

// ---- store

function createTaskStore({ file, encrypt, decrypt, available = () => true, limit = LIMITS.tasks }) {
  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const body = data.enc ? JSON.parse(decrypt(data.enc)) : data;
      return capTasks((Array.isArray(body.tasks) ? body.tasks : []).map(sanitizeTask).filter(Boolean), limit);
    } catch {
      return []; // none yet, or unreadable on this machine
    }
  }
  // Returns false when nothing could be kept (no keychain).
  function save(tasks) {
    if (!available()) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, enc: encrypt(JSON.stringify({ tasks: capTasks(tasks, limit) })) }));
    fs.renameSync(tmp, file); // never a half-written file
    return true;
  }
  return { load, save };
}

module.exports = {
  LIMITS, STATUSES, ACTIVE, OCCUPYING, TRANSITIONS, canTransition, DEFAULT_SETTINGS, TIMEOUT_CHOICES, normalizeSettings, backgroundStepLimit,
  CLI_ENGINES, engineOfModel, isCliModel, taskModels, cliProblem, cliStates, cliMaxTurns, cliTaskUsage, cliUsageReport,
  hostOfUrl, hostFromToken, hostsInText, withWww, allowedSitesFor,
  normalizeSchedule, isRecurring, nextRunAt, isDue, planStarts,
  normalizePageText, digest, parseCondition, watchDecision, parseVerdict,
  makeTask, sanitizeTask, recoverAfterRestart, fitsAnother, capTasks, summarize, badgeCounts, createTaskStore,
};
