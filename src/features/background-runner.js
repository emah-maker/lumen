// Runs background tasks (features/background-agents.js has the model, schedules and store).
//
// Each run is a fresh Agent (agent.js) with its own message history, approved sites, abort signal and
// work tab: a WebContentsView that is never attached to a window, so it is not in the tab strip and
// the user's tabs are out of its reach. The agent sees a one-tab browser (browserFor): list_tabs shows
// the work tab only, switch_tab / close_tab / tab groups do nothing to the user's tabs, open_tab loads in
// the work tab. Safety, on top of the agent's own gate (ensureAllowed / tainted-run rules):
// - the run counts as tainted from the start, so every site outside the task's allowed sites asks;
// - nothing auto-approves (autoApprove is off, MCP "always allow" is ignored) and there is nobody to ask
//   in the moment: a question becomes a card in the Tasks panel and the task waits ('waiting-approval');
// - purchase / send / submit steps ask every time, even on allowed sites;
// - a page's own jump to a site that isn't allowed is stopped;
// - MCP-client tools are off unless the user ticked them for the task; private windows have no access.
// Models: an API model (the agent's own loop) or the user's Claude Code / Grok Build CLI. A CLI run is
// its own process, made for that task (deps.cliEngine: a fresh engine, session, temp folder and MCP tag,
// nothing shared with the sidebar's CLI session), and drives the browser through Lumen's MCP server:
// every call it makes arrives tagged with the run and is executed by THIS task's agent (features/
// ai-agents.js mcpCallTool), so the work tab, allowed sites, taint, and approval cards (Tasks panel;
// the tool call waits for the answer) are the task's, exactly as for an API run.
// Routines (features/routines.js) are tasks on a calendar schedule. One timer wakes for the earliest
// routine (runRoutines); a due one is queued like any task, so the concurrency cap, approvals and work
// tab are the same. Missed times run once after a restart or a wake from sleep (powerMonitor 'resume').
const crypto = require('crypto');
const { WebContentsView, Notification, BrowserWindow } = require('electron');
const { Agent, cliSystemPrompt } = require('../ai/agent');
const { engineModel } = require('../ai/cli-utils');
const autoModel = require('../ai/auto-model');
const { LIMIT_NOTICE } = require('../ai/loop-guard');
const bg = require('./background-agents');
const routines = require('./routines');

const WORK_TAB = 1; // the id the agent sees for its one tab
const CLAUDE_WORLD = 1001; // agent.js's isolated world: where page-scripts keep their element registry
const RISKY_CLICK = /\b(buy|purchase|pay|checkout|check out|place (?:your |the )?order|order now|complete (?:order|purchase)|confirm (?:order|purchase|payment)|send|submit|post|publish|tweet|reply|delete|subscribe|sign up|register|book now|reserve|transfer|donate|apply)\b/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isLocalEngine = bg.isCliModel;

// The agent, made to work for a task. See the header for what it changes.
class TaskAgent extends Agent {
  constructor(browser, getClient, getOptions, getKey, hooks) {
    super(browser, getClient, getOptions, getKey);
    this.hooks = hooks;
    this.onceKeys = new Set(); // hosts approved "once": dropped again when the tool that needed them ends
    this.baseHosts = new Set(); // the task's allowed sites, and the ones approved for the whole task
    this.depth = 0;
  }

  async ensureAllowed(name, emit, signal, opts = {}) {
    await super.ensureAllowed(name, emit, signal, opts);
    const risk = await this.hooks.riskOf(name, opts.input || {}, this);
    if (!risk) return;
    const who = opts.who || 'The AI';
    const ok = await this.askApproval(risk.host, emit, signal, { action: 'tool', who, title: `${who} wants to ${risk.what}`, args: risk.detail });
    if (!ok) throw new Error(`The user did not allow ${who} to ${risk.what}. Do not try again: finish with what you have and say that this step needs the user.`);
  }

  // The run scope a CLI engine's MCP calls use (set by agent.inTask for a run with a chat: runCli).
  engineScope() {
    return this.runScope || null;
  }

  async execute(name, input) {
    this.depth++;
    try {
      return await super.execute(name, input);
    } finally {
      if (--this.depth === 0) this.revokeOnce();
    }
  }

  revokeOnce() {
    for (const key of this.onceKeys) if (key.startsWith('script:') || !this.baseHosts.has(key)) this.approvedHosts.delete(key);
    this.onceKeys.clear();
  }
}

function create(deps) {
  const now = deps.now || (() => Date.now());
  const store = bg.createTaskStore({ file: deps.file, encrypt: deps.encrypt, decrypt: deps.decrypt, available: deps.available });
  let tasks = [];
  const runtimes = new Map(); // task id -> { task, agent, view, wc, pending: Map, ... } for runs in progress
  const checking = new Set(); // watch checks in progress
  const notifications = []; // what was announced (tests read this)
  let saveTimer = null;
  let broadcastTimer = null;
  let ticker = null;
  let started = false;
  let routineTimer = null; // the one timer for every routine: set for the earliest next run (runRoutines)
  let routinesOffline = []; // routines due while there is no connection: they start when it is back
  let onlineCheck = () => (deps.isOnline ? deps.isOnline() : true);

  const settings = () => bg.normalizeSettings(deps.readSettings().bgTasks);
  const find = (id) => tasks.find((t) => t.id === String(id));
  const ui = () => deps.ui();

  // ---- persistence and UI updates
  let closed = false; // after the final save on quit, the runs being stopped must not overwrite it
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (closed) return;
    try { store.save(tasks); } catch (err) { console.error('[lumen] could not save background tasks:', err.message); }
  }
  function saveSoon() {
    if (!saveTimer) saveTimer = setTimeout(saveNow, 400);
  }
  const slots = () => Math.min(settings().maxConcurrent, deps.maxBackgroundTasks?.() ?? Infinity); // Performance mode can lower the setting
  const pendingOf = (id) => [...(runtimes.get(id)?.pending.values() || [])];
  function state() {
    const t = now();
    const queue = bg.queueInfo(tasks, slots(), t);
    return {
      tasks: [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).map((x) => bg.summarize(x, t, pendingOf(x.id), { queue: queue[x.id], waitingSince: runtimes.get(x.id)?.waitingSince || 0 })),
      badge: bg.badgeCounts(tasks), unseen: bg.unseenCount(tasks), settings: settings(), slots: slots(), running: runtimes.size, offline: routinesOffline.length > 0,
    };
  }
  function broadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      ui()?.send('tasks:state', state());
    }, 80);
  }
  function touch(task) {
    task.updatedAt = now();
    saveSoon();
    broadcast();
  }
  const appFocused = () => (deps.isFocused ? deps.isFocused() : BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused()));
  // Tell the user: an in-app banner, and a system notification when Lumen is not the window in front.
  // bg.notifyPlan decides (the setting, "finished" on its own being optional, focus).
  function announce(task, kind, text) {
    const entry = { id: task.id, kind, title: task.title, text };
    notifications.push(entry);
    const plan = bg.notifyPlan(kind, { settings: settings(), focused: appFocused() });
    if (plan.toast) ui()?.send('tasks:toast', entry);
    if (!plan.os || deps.test || !Notification.isSupported()) return;
    try {
      const n = new Notification({ title: task.title, body: text, silent: false });
      n.on('click', () => { deps.focusApp?.(); ui()?.send('tasks:open', { id: task.id }); });
      n.show();
    } catch {}
  }

  function transition(task, next) {
    if (task.status === next) return true;
    if (!bg.canTransition(task.status, next)) return false;
    task.status = next;
    touch(task);
    return true;
  }

  // ---- models
  // The connected API models, and Claude Code / Grok Build models when installed (and not signed out).
  const allModels = () => bg.taskModels(deps.modelOptions());
  const usableModels = () => allModels().filter((m) => m.available);
  function pickModel(wanted) {
    const list = usableModels();
    if (wanted && list.some((o) => o.id === wanted)) return wanted;
    const current = deps.currentModel?.();
    if (current && list.some((o) => o.id === current)) return current;
    return (list.find((o) => o.engine === 'api' && o.id !== 'auto') || list.find((o) => o.engine === 'api') || list[0])?.id || null;
  }
  const cliError = (model) => { const p = bg.cliProblem(model, deps.cliStatus?.()); return p ? deps.t(p.key, p.params) : null; };

  // What the "Create" card shows before anything is made: the model, and the sites it may visit.
  function preview({ prompt = '', pageUrl = '', model } = {}) {
    const list = allModels();
    const id = pickModel(model);
    return {
      enabled: settings().enabled,
      model: id,
      label: list.find((o) => o.id === id)?.label || id || '',
      models: list.map((o) => ({ id: o.id, label: o.label, group: o.group || '', engine: o.engine, available: o.available })),
      cli: bg.cliStates(deps.cliStatus?.()), // Claude Code / Grok Build: ready, not installed, or not signed in
      // Shown without the www twins (creating the task adds them back), so the list stays short.
      sites: bg.allowedSitesFor(prompt, pageUrl || deps.activeUrl?.() || '').filter((s, _i, all) => !(s.startsWith('www.') && all.includes(s.slice(4)))),
      pageUrl: pageUrl || deps.activeUrl?.() || '',
      hasMcp: Boolean(deps.externalTools),
    };
  }

  // ---- creating, editing, deleting
  function createTask({ title, prompt, schedule, sites, model, signedIn, allowMcp, confirmed, pageUrl, startUrl }) {
    if (!settings().enabled) throw new Error(deps.t('tasks.error.disabled'));
    if (confirmed !== true) throw new Error(deps.t('tasks.error.confirm'));
    if (!bg.fitsAnother(tasks)) throw new Error(deps.t('tasks.error.full'));
    if (model && isLocalEngine(model) && cliError(model)) throw new Error(cliError(model)); // said now, not when it runs
    const chosen = pickModel(model);
    if (!chosen) throw new Error(deps.t('tasks.error.noModel'));
    // The user's MCP tools reach API models only (a CLI run has Lumen's browser tools and nothing else).
    const task = bg.makeTask({ title, prompt, model: chosen, schedule, allowedSites: Array.isArray(sites) ? sites : bg.allowedSitesFor(prompt, pageUrl), signedIn, allowMcp: Boolean(allowMcp) && Boolean(deps.externalTools) && !isLocalEngine(chosen), pageUrl, startUrl, now: now() });
    tasks.push(task);
    tasks = bg.capTasks(tasks);
    saveSoon();
    broadcast();
    pump();
    tick();
    if (task.routine) runRoutines();
    return task;
  }

  function remove(id) {
    const task = find(id);
    if (!task) return false;
    stop(id);
    tasks = tasks.filter((t) => t !== task);
    saveSoon();
    broadcast();
    if (task.routine) runRoutines();
    return true;
  }

  // Run now / Retry.
  // Resume goes on from what an interrupted run had done (the model is told); Retry starts over.
  function run(id, { resume = false } = {}) {
    const task = find(id);
    if (!task || !settings().enabled) return false;
    if (bg.ACTIVE.has(task.status) && task.status !== 'queued') return false;
    if (resume && bg.resumable(task)) task.resume = task.resume || bg.resumeInfo(task);
    else if (task.status !== 'queued') task.resume = null;
    if (task.schedule.type === 'watch' && !task.judge) { checkWatch(task, { manual: true }); return true; }
    if (task.status !== 'queued' && !transition(task, 'queued')) return false;
    if (task.routine && !task.routine.trigger) { task.routine.trigger = 'manual'; task.routine.scheduledFor = null; }
    task.queuedAt = now();
    task.unseen = false;
    touch(task);
    pump();
    return true;
  }

  // Edit-and-rerun: change the request, title or sites of a task that is not running; the caller may run it.
  function edit(id, patch, { andRun = false } = {}) {
    const task = find(id);
    if (!task) return { ok: false, error: 'No such task.' };
    let next;
    try { next = bg.applyEdit(task, patch, now()); } catch (err) { return { ok: false, error: err.message }; }
    Object.assign(task, next);
    task.resume = null;
    touch(task);
    if (andRun) run(id);
    return { ok: true };
  }

  function setSchedule(id, raw) {
    const task = find(id);
    if (!task) return { ok: false, error: 'No such task.' };
    let schedule;
    try {
      schedule = bg.normalizeSchedule(raw, now());
      if ((schedule.type === 'routine') !== Boolean(task.routine)) throw new Error(deps.t('routines.error.kind')); // a routine stays a routine
      if (task.routine) routines.validateNew(schedule, now());
    } catch (err) { return { ok: false, error: errorText(err) }; }
    task.schedule = schedule;
    task.enabled = true;
    if (task.routine) { task.routine.lastDue = now(); touch(task); runRoutines(); return { ok: true }; } // from now on: an earlier time today doesn't run
    if (schedule.type === 'watch') {
      task.watch = { hash: null, holding: false, judgedHash: null, checkedAt: null, changedAt: null };
      task.allowedSites = [...new Set([...task.allowedSites, ...bg.withWww(bg.hostOfUrl(schedule.url))])].slice(0, bg.LIMITS.sites);
    } else task.watch = null;
    if (!bg.ACTIVE.has(task.status)) {
      if (schedule.type === 'at') task.lastRun = null;
      if (schedule.type === 'now') { task.lastRun = null; }
      if ((schedule.type === 'at' || schedule.type === 'now') && bg.canTransition(task.status, 'queued')) { task.status = 'queued'; task.queuedAt = schedule.type === 'at' ? schedule.at : now(); }
    }
    touch(task);
    pump();
    return { ok: true };
  }

  function setEnabled(id, on) {
    const task = find(id);
    if (!task) return false;
    task.enabled = Boolean(on);
    if (task.routine && task.enabled) task.routine.lastDue = now(); // resuming doesn't run the times it was paused for
    touch(task);
    if (task.routine) runRoutines();
    return true;
  }

  // ---- scheduling
  function tick() {
    if (!settings().enabled) return;
    const t = now();
    for (const task of tasks) {
      if (task.schedule.type === 'routine') continue; // its own timer (runRoutines)
      if (task.schedule.type === 'watch') {
        // A watch is checked on its interval whatever it last showed, unless a check or a model run is under way.
        const busy = runtimes.has(task.id) || checking.has(task.id) || task.judge || bg.OCCUPYING.has(task.status);
        const next = bg.nextRunAt(task);
        if (!busy && next !== null && next <= t) checkWatch(task);
      } else if (bg.isDue(task, t) && bg.canTransition(task.status, 'queued')) { task.status = 'queued'; task.queuedAt = t; touch(task); }
    }
    pump();
  }

  function pump() {
    if (!settings().enabled) return;
    for (const id of bg.planStarts(tasks, Math.min(settings().maxConcurrent, deps.maxBackgroundTasks?.() ?? Infinity), now())) {
      const task = find(id);
      if (task && !runtimes.has(id) && (task.schedule.type !== 'watch' || task.judge)) startRun(task, task.judge ? 'judge' : 'run');
    }
  }

  // ---- routines: one timer, set for the earliest next run of any routine (nothing polls while idle)
  const errorText = (err) => (err?.key ? deps.t(err.key, err.params) : String(err?.message || err));
  function armRoutines(ms) {
    clearTimeout(routineTimer);
    routineTimer = null;
    if (ms === null || closed) return;
    routineTimer = setTimeout(runRoutines, ms);
    routineTimer.unref?.();
  }
  function runRoutines() {
    if (closed) return;
    const t = now();
    const p = routines.plan(tasks, t, { online: onlineCheck() !== false, enabled: settings().enabled, isActive: (x) => bg.ACTIVE.has(x.status) || runtimes.has(x.id) || checking.has(x.id) });
    for (const { id, dueAt, trigger } of p.queue) {
      const task = find(id);
      if (!task || !bg.canTransition(task.status, 'queued')) continue;
      task.status = 'queued';
      task.queuedAt = t;
      task.resume = null;
      Object.assign(task.routine, { lastDue: t, trigger, scheduledFor: dueAt }); // once, however many times were missed
      touch(task);
    }
    for (const { id, dueAt } of p.skip) { // its previous run is still going: never two at once
      const task = find(id);
      if (!task) continue;
      task.routine.lastDue = t;
      task.routine.history = routines.addHistory(task.routine.history, { startedAt: t, endedAt: t, status: 'skipped', trigger: 'schedule', scheduledFor: dueAt, error: deps.t('routines.history.skipped') });
      touch(task);
    }
    if (p.offline.join() !== routinesOffline.join()) { routinesOffline = p.offline; broadcast(); }
    if (p.queue.length) pump();
    armRoutines(routines.sleepFor(p.wakeAt, t));
  }

  // Create or change a routine (the Routines editor). Throws with a message for the user.
  function saveRoutine(spec = {}) {
    let schedule;
    try { schedule = routines.validateNew(routines.normalizeRoutineSchedule(spec.schedule, now()), now()); } catch (err) { throw new Error(errorText(err)); }
    const start = routines.webUrl(spec.startUrl);
    if (start === null) throw new Error(deps.t('routines.error.startUrl'));
    const sites = Array.isArray(spec.sites) ? spec.sites.map(String) : undefined;
    if (!spec.id) return createTask({ title: spec.title, prompt: spec.prompt, schedule, sites, model: spec.model, signedIn: spec.signedIn, allowMcp: spec.allowMcp, confirmed: spec.confirmed, startUrl: start });
    const task = find(spec.id);
    if (!task?.routine) throw new Error(deps.t('routines.error.missing'));
    if (bg.OCCUPYING.has(task.status)) throw new Error(deps.t('routines.error.busy'));
    const next = bg.applyEdit(task, { title: spec.title, prompt: spec.prompt, sites: [...(sites || task.allowedSites), ...(start ? [start] : [])] }, now());
    if (spec.model && spec.model !== task.model) {
      if (isLocalEngine(spec.model) && cliError(spec.model)) throw new Error(cliError(spec.model));
      if (pickModel(spec.model) !== spec.model) throw new Error(deps.t('tasks.error.noModel'));
      next.model = spec.model;
      next.engine = bg.engineOfModel(spec.model);
    }
    next.signedIn = spec.signedIn === undefined ? task.signedIn : Boolean(spec.signedIn);
    next.allowMcp = Boolean(spec.allowMcp ?? task.allowMcp) && Boolean(deps.externalTools) && !isLocalEngine(next.model);
    next.schedule = schedule;
    next.enabled = spec.enabled !== false;
    next.routine = { ...task.routine, startUrl: start, lastDue: now() };
    Object.assign(task, next);
    touch(task);
    runRoutines();
    return task;
  }

  // The editor's live line: the next three run times, or why the schedule can't be saved; and with
  // `text`, a schedule read from "every weekday at 8am: ..." (the /routine command).
  function routinePreview({ schedule, text } = {}) {
    const out = { ok: true, next: [], error: '' };
    if (typeof text === 'string') out.parsed = routines.parseScheduleText(text);
    if (schedule) {
      try { out.next = routines.upcoming(routines.validateNew(routines.normalizeRoutineSchedule(schedule, now()), now()), now(), 3); } catch (err) { out.ok = false; out.error = errorText(err); }
    }
    return out;
  }

  // ---- work tab
  function makeWorkView(task, allowedNav) {
    const webPreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false };
    // Without "use my sign-ins": a private in-memory session (no cookies from the user's browsing).
    if (!task.signedIn) webPreferences.partition = `bg-task-${task.id}-${now()}`;
    const view = new WebContentsView({ webPreferences });
    view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
    const wc = view.webContents;
    wc.setAudioMuted(true);
    if (!task.signedIn) {
      wc.session.setPermissionRequestHandler((_w, _p, callback) => callback(false));
      wc.session.setPermissionCheckHandler(() => false);
      wc.session.on('will-download', (event) => event.preventDefault());
    }
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && allowedNav(url)) wc.loadURL(url).catch(() => {}); // a link that opens "a new tab": same tab
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event) => {
      const url = event.url;
      if (!/^https?:/i.test(url) || allowedNav(url)) return;
      event.preventDefault();
    });
    wc.on('did-stop-loading', () => {
      const url = wc.isDestroyed() ? '' : wc.getURL();
      if (url && /^https?:/i.test(url) && url !== task.currentUrl) { task.currentUrl = url; task.pages = bg.addVisit(task.pages || [], url); broadcast(); }
    });
    return view;
  }

  // ---- the one-tab browser the task's agent sees
  function browserFor(rt) {
    const { task } = rt;
    const tab = () => (rt.wc && !rt.wc.isDestroyed() ? { id: WORK_TAB, webContents: rt.wc } : null);
    const unavailable = () => { throw new Error('Tab groups are not available in background tasks.'); };
    const ext = deps.externalTools && task.allowMcp ? {
      isExternal: (n) => deps.externalTools.isExternal(n),
      tools: () => deps.externalTools.tools(),
      lookupTool: (n) => deps.externalTools.lookupTool(n),
      call: (n, i) => deps.externalTools.call(n, i),
      isAlwaysAllowed: () => false, // nothing is remembered as allowed in the background
      setAlwaysAllowed: () => {},
    } : undefined;
    return {
      externalTools: ext,
      activeTab: tab,
      tabById: (id) => (id === WORK_TAB ? tab() : null),
      noTabReason: () => 'This background task’s tab is closed.',
      listTabs: () => (tab() ? [{ id: WORK_TAB, title: rt.wc.getTitle(), url: rt.wc.getURL(), active: true }] : []),
      openTab: (url) => { rt.wc.loadURL(url).catch(() => {}); return tab(); },
      switchTab: (id) => id === WORK_TAB,
      closeTab: () => {},
      requestCloseTab: () => {},
      hasUnsavedInput: async () => false,
      groupTabs: unavailable,
      ungroupTabs: unavailable,
      effectiveModel: (m) => m, // the model is frozen when the task is made ('auto' is chosen at each run instead: autoRoute, API models only)
      autoRoute: deps.autoRoute ? (a) => deps.autoRoute({ ...a, request: { ...a.request, kind: a.request?.kind === 'chat' ? 'agentic' : a.request?.kind } }) : undefined,
      autoEscalate: deps.autoEscalate, autoDeny: deps.autoDeny, // (no onAuto: nothing in a task's window shows it)
      anthropicAuth: () => deps.anthropicAuth?.(),
      aiOff: (url) => deps.aiOff?.(url),
      autoApprove: () => false, // never, whatever the sidebar's switch says
      maxSteps: () => (rt.kind === 'judge' ? 8 : bg.backgroundStepLimit(deps.maxSteps?.())),
    };
  }

  // Would this step buy, send, post or submit something? It asks each time.
  async function riskOf(name, input, agent) {
    const wc = agent.taskTab()?.webContents;
    const host = (() => { try { return new URL(wc?.getURL()).host; } catch { return 'this page'; } })();
    if (name === 'fill_form' && input.submit) {
      const detail = (input.fields || []).map((f) => `${f.label}: ${String(f.value).slice(0, 80)}`).join('\n');
      return { host, what: `fill in and submit a form on ${host}`, detail };
    }
    let label = '';
    if (name === 'click') {
      label = input.text || '';
      if (!label && Number.isInteger(input.element_id) && wc) {
        try { label = (await wc.executeJavaScriptInIsolatedWorld(CLAUDE_WORLD, [{ code: require('../ai/page-scripts').labelOf(input.element_id) }]))?.label || ''; } catch {}
      }
    }
    return label && RISKY_CLICK.test(label) ? { host, what: `click “${label.slice(0, 60)}” on ${host}`, detail: `A button or link on ${host} that looks like it buys, sends, posts or submits something.` } : null;
  }

  // ---- a run
  function startRun(task, kind) {
    if (!transition(task, 'running')) return;
    const started = now();
    task.lastRun = started;
    const previous = task.result; // a repeating task compares with the run before; a failed one keeps it
    const resume = task.resume;
    task.resume = null;
    task.steps = [];
    task.stepCount = 0;
    task.result = kind === 'judge' ? task.result : '';
    task.resultOld = false;
    task.pages = [];
    task.error = '';
    task.notice = '';
    task.usage = null;
    task.judge = false;
    const trigger = task.routine?.trigger || 'manual';
    const scheduledFor = task.routine?.scheduledFor ?? null;
    if (task.routine) { task.routine.trigger = null; task.routine.scheduledFor = null; }
    const rt = { task, kind, started, previous, resume, trigger, scheduledFor, pending: new Map(), turnText: '', stopped: false, timedOut: false, waitedMs: 0, waitingSince: 0, steps: new Map(), agent: null, view: null, wc: null, timer: null };
    runtimes.set(task.id, rt);
    touch(task);

    const finish = async () => {
      clearInterval(rt.timer);
      const text = (rt.turnText || lastText(rt.agent?.messages || [])).trim();
      try { rt.view?.webContents.close(); } catch {}
      runtimes.delete(task.id);
      const ended = now();
      const status = rt.stopped ? 'stopped' : (rt.timedOut || task.error) ? 'failed' : 'done';
      if (rt.timedOut && !task.error) task.error = deps.t('tasks.error.timeout', { minutes: settings().timeoutMin });
      if (kind !== 'judge') { const kept = bg.chooseResult(text.slice(0, bg.LIMITS.result), previous); task.result = kept.result; task.resultOld = kept.old; }
      task.resume = status === 'failed' && kind !== 'judge' ? bg.resumeInfo(task) : null;
      task.unseen = kind !== 'judge' && status !== 'stopped';
      if (rt.stopped) task.error = '';
      task.runs = [...task.runs, { startedAt: started, endedAt: ended, status, summary: (task.error || text).replace(/\s+/g, ' ').slice(0, 300), cost: task.usage?.cost ?? null, steps: task.stepCount, kind, ...(rt.session ? { session: rt.session } : {}) }].slice(-bg.LIMITS.runs);
      task.status = 'running'; // the state machine has the final say below
      transition(task, status);
      if (task.routine && kind === 'run') task.routine.history = routines.addHistory(task.routine.history, { startedAt: started, endedAt: ended, status, trigger: rt.trigger, scheduledFor: rt.scheduledFor, result: task.resultOld ? '' : task.result, error: task.error });
      const notify = task.routine ? 'routines.notify' : 'tasks.notify';
      if (kind === 'judge') applyVerdict(task, rt, text);
      else if (status === 'done') announce(task, 'done', deps.t(`${notify}.done`, { title: task.title }));
      else if (status === 'failed') announce(task, 'failed', deps.t(`${notify}.failed`, { title: task.title, error: task.error }));
      saveSoon();
      broadcast();
      pump();
      if (task.routine) runRoutines();
    };

    (async () => {
      try {
        if (deps.effectiveModel && deps.effectiveModel(task.model) !== task.model) throw new Error(deps.t('tasks.error.modelGone', { model: task.model }));
        if (isLocalEngine(task.model) && cliError(task.model)) throw new Error(cliError(task.model)); // signed out, or the CLI is gone
        const start = task.routine?.startUrl;
        if (start && deps.aiOff?.(start)) throw new Error(deps.t('tasks.error.aiOff', { host: bg.hostOfUrl(start) })); // a routine's start page with AI off: it doesn't run at all
        const agent = new TaskAgent(browserFor(rt), () => deps.getClient(), () => ({ adhdMode: false, model: task.model, pageContext: false }), (p) => deps.getKey(p), { riskOf });
        rt.agent = agent;
        agent.baseHosts = new Set(task.allowedSites);
        agent.approvedHosts = new Set(task.allowedSites);
        agent.messages.settings = { model: task.model, adhdMode: false };
        agent.messages.tainted = true; // every site outside the allowed ones asks first
        agent.onUsage = (engine, data) => deps.reportUsage?.(engine, data);
        const allowedNav = (url) => {
          try {
            const host = new URL(url).host.toLowerCase();
            return host === new URL(rt.wc.getURL() || 'about:blank').host.toLowerCase() || agent.approvedHosts.has(host);
          } catch { return false; }
        };
        rt.view = makeWorkView(task, allowedNav);
        rt.wc = rt.view.webContents;
        rt.timer = setInterval(() => {
          if (rt.waitingSince && bg.approvalExpired(rt.waitingSince, now(), settings().approvalWaitMin)) {
            // Nobody answered: refuse what is waiting, so the task ends its step and the slot is not held for days.
            task.notice = deps.t('tasks.notice.approvalExpired', { minutes: settings().approvalWaitMin });
            for (const id of [...rt.pending.keys()]) agent.resolveApproval(id, false);
          }
          if (rt.waitingSince) return; // waiting for the user doesn't use up the time
          if (now() - rt.started - rt.waitedMs > settings().timeoutMin * 60000) { rt.timedOut = true; agent.stop(); }
        }, 2000);
        rt.timer.unref?.();
        const words = bg.taskPrompt(task, kind, { previous: task.runs.length ? rt.previous : '', resume: rt.resume });
        if (isLocalEngine(task.model)) await runCli(rt, agent, words);
        else await agent.run(words, (e) => onEvent(rt, e));
      } catch (err) {
        task.error = String(err?.message || err).slice(0, 300);
      } finally {
        await finish();
      }
    })();
  }

  // A run on the user's own Claude Code / Grok Build. Its own engine (deps.cliEngine): a separate process
  // with its own session, temp folder and MCP tag, so it can run beside a sidebar chat and other tasks.
  // The agent's tab pin is a scope on the work tab (agent.inTask with the run's messages, which already
  // count as having read page content), and the engine hands the agent to mcpCallTool (runAgent). Stop,
  // the timeout and quitting abort the controller: the engine ends the whole process tree. The turn cap
  // is --max-turns; hitting it is a notice, not a failure.
  async function runCli(rt, agent, prompt) {
    const { task } = rt;
    const kind = bg.engineOfModel(task.model);
    // [auto model] The CLI's own Auto ('claudecode:auto'): this run goes to one of that CLI's models, chosen from the task's words.
    let model = task.model;
    if (autoModel.isAuto(model)) {
      const d = deps.autoRoute?.({ request: { kind: 'agentic', prompt }, scope: autoModel.scopeOf(model), last: null });
      if (!d?.id || bg.engineOfModel(d.id) !== kind) throw new Error(d?.reason || deps.t('tasks.error.noModel'));
      model = d.id;
    }
    const cli = await deps.cliEngine?.(kind);
    if (!cli) throw new Error(deps.t('tasks.error.cliMissing', { name: bg.CLI_ENGINES[kind] }));
    const controller = new AbortController();
    agent.controller = controller;
    rt.cli = cli.engine;
    const emit = (e) => onEvent(rt, e);
    try {
      if (rt.stopped || rt.timedOut) controller.abort();
      emit({ type: 'turn_start' });
      const out = await agent.inTask(WORK_TAB, controller.signal, () => cli.engine.run({
        prompt,
        images: [],
        sessionId: crypto.randomUUID(),
        resume: false,
        model: engineModel(model),
        maxTurns: bg.cliMaxTurns(deps.maxSteps?.(), rt.kind),
        systemPrompt: cliSystemPrompt({ model, adhdMode: false }, kind, { background: true }),
        signal: controller.signal,
        emit,
        runAgent: agent,
      }), agent.messages);
      rt.session = out.sessionId || null;
      if (out.text) rt.turnText = out.text;
      const usage = bg.cliTaskUsage(task.usage, out, model);
      if (usage) { task.usage = usage; touch(task); }
      if (out.usage) deps.reportUsage?.(kind, bg.cliUsageReport(out, engineModel(model)));
      if (out.limit) emit({ type: 'notice', text: LIMIT_NOTICE });
      if (out.failed && !task.error && !rt.stopped) task.error = deps.t('tasks.error.cliFailed', { name: bg.CLI_ENGINES[kind] });
    } finally {
      agent.controller = null;
      cli.release();
    }
  }

  function lastText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
      if (text) return text;
    }
    return '';
  }

  function onEvent(rt, e) {
    const { task } = rt;
    switch (e.type) {
      case 'turn_start': rt.turnText = ''; break;
      case 'text': rt.turnText += e.text; break;
      case 'text_block': if (rt.turnText) rt.turnText += '\n\n'; break;
      case 'tool': {
        const step = { name: String(e.name).slice(0, 40), label: String(e.label || e.name).slice(0, 160), at: now(), ok: null, error: '' };
        rt.steps.set(e.id, step);
        task.steps.push(step);
        task.stepCount++;
        if (task.steps.length > bg.LIMITS.steps) task.steps.shift();
        touch(task);
        break;
      }
      case 'tool_done': {
        const step = rt.steps.get(e.id);
        if (step) { step.ok = Boolean(e.ok); step.error = e.error ? String(e.error).slice(0, 160) : ''; touch(task); }
        break;
      }
      case 'approval': {
        rt.pending.set(e.approvalId, { approvalId: e.approvalId, host: String(e.host || ''), action: e.action || 'interact', title: e.title || '', query: e.query, args: e.args ? String(e.args).slice(0, 1500) : '' });
        if (!rt.waitingSince) rt.waitingSince = now();
        const was = task.status;
        if (transition(task, 'waiting-approval') && was !== 'waiting-approval') announce(task, 'approval', deps.t(task.routine ? 'routines.notify.approval' : 'tasks.notify.approval', { title: task.title })); // one message per wait, not per card
        else broadcast();
        break;
      }
      case 'approval_done': {
        rt.pending.delete(e.approvalId);
        if (!rt.pending.size) {
          if (rt.waitingSince) { rt.waitedMs += now() - rt.waitingSince; rt.waitingSince = 0; }
          transition(task, 'running');
        } else broadcast();
        break;
      }
      case 'usage': task.usage = e.usage; touch(task); break;
      case 'notice': if (e.text && e.text !== 'Stopped.') { task.notice = String(e.text).slice(0, 200); touch(task); } break;
      case 'error': task.error = String(e.text || 'Something went wrong.').slice(0, 300); break;
      default: break;
    }
  }

  // The user's answer to a card in the panel: 'once', 'site' (for this task), or 'deny'.
  function approve(id, approvalId, choice) {
    const rt = runtimes.get(String(id));
    const card = rt?.pending.get(approvalId);
    if (!card) return false;
    if (choice === 'deny') { rt.agent.resolveApproval(approvalId, false); return true; }
    const agent = rt.agent;
    const siteOk = card.action === 'interact' || card.action === 'open' || card.action === 'script';
    if (choice === 'site' && siteOk && card.host) {
      agent.baseHosts.add(card.host);
      agent.approvedHosts.add(card.host);
      if (card.action === 'script') { agent.baseHosts.add(`script:${card.host}`); agent.approvedHosts.add(`script:${card.host}`); }
      if (!rt.task.allowedSites.includes(card.host)) rt.task.allowedSites.push(card.host);
    } else if (card.host) {
      agent.onceKeys.add(card.host);
      agent.onceKeys.add(`script:${card.host}`);
    }
    agent.resolveApproval(approvalId, true);
    return true;
  }

  function stop(id) {
    const task = find(id);
    if (!task) return false;
    const rt = runtimes.get(task.id);
    if (rt) { rt.stopped = true; rt.agent?.stop(); return true; }
    if (task.status === 'queued') { transition(task, 'stopped'); task.lastRun = now(); if (task.routine) Object.assign(task.routine, { trigger: null, scheduledFor: null }); return true; }
    return false;
  }

  // ---- watching a page
  async function loadAndRead(task, url) {
    const view = makeWorkView(task, (u) => bg.hostOfUrl(u) === bg.hostOfUrl(url) || task.allowedSites.includes(bg.hostOfUrl(u)));
    const wc = view.webContents;
    let blocked = '';
    wc.on('will-redirect', (event) => {
      const host = bg.hostOfUrl(event.url);
      if (host && !task.allowedSites.includes(host) && host !== bg.hostOfUrl(url)) { event.preventDefault(); blocked = host; }
    });
    try {
      await Promise.race([wc.loadURL(url).catch(() => {}), sleep(20000)]);
      await sleep(deps.test ? 100 : 1200);
      if (blocked) throw new Error(deps.t('tasks.error.redirect', { host: blocked }));
      const text = await Promise.race([
        wc.executeJavaScriptInIsolatedWorld(CLAUDE_WORLD, [{ code: '(document.body ? document.body.innerText : "")' }]),
        sleep(8000).then(() => { throw new Error(deps.t('tasks.error.noRead')); }),
      ]);
      return String(text || '');
    } finally {
      try { wc.close(); } catch {}
    }
  }

  // The cheap path: load the page, compare it with the last look, and only ask the model when it has to.
  async function checkWatch(task, { manual = false } = {}) {
    if (checking.has(task.id) || runtimes.has(task.id) || (checking.size >= 2 && !manual)) return;
    checking.add(task.id);
    const started = now();
    task.lastRun = started;
    try {
      const url = task.schedule.url;
      const host = bg.hostOfUrl(url);
      if (!host || !(task.allowedSites.includes(host))) throw new Error(deps.t('tasks.error.siteNotAllowed', { host }));
      if (deps.aiOff?.(url)) throw new Error(deps.t('tasks.error.aiOff', { host }));
      const text = await loadAndRead(task, url);
      const w = task.watch || (task.watch = { hash: null, holding: false, judgedHash: null, checkedAt: null, changedAt: null });
      const d = bg.watchDecision(w, text, task.schedule.condition);
      w.checkedAt = now();
      task.error = '';
      task.currentUrl = url;
      const record = (summary) => { task.runs = [...task.runs, { startedAt: started, endedAt: now(), status: 'done', summary, cost: null, steps: 0, kind: 'watch' }].slice(-bg.LIMITS.runs); };
      if (d.action === 'judge') {
        // Only now does the model get involved: it looks at the page and answers MATCH / NO MATCH.
        w.pendingHash = d.hash;
        w.changedAt = now();
        task.judge = true;
        task.status = 'queued';
        task.queuedAt = now();
      } else {
        w.hash = d.hash;
        w.holding = d.holding;
        if (d.action === 'notify') {
          w.changedAt = now();
          task.result = `${d.reason}\n\n${bg.normalizePageText(text).slice(0, 600)}`;
          record(d.reason);
          announce(task, 'watch', deps.t('tasks.notify.watch', { title: task.title, reason: d.reason }));
        }
        task.status = 'done'; // between checks a watch is idle: not "queued" or "failed" any more
      }
      touch(task);
    } catch (err) {
      task.error = String(err?.message || err).slice(0, 300);
      task.runs = [...task.runs, { startedAt: started, endedAt: now(), status: 'failed', summary: task.error, cost: null, steps: 0, kind: 'watch' }].slice(-bg.LIMITS.runs);
      task.status = 'failed';
      touch(task);
    } finally {
      checking.delete(task.id);
      broadcast();
      pump();
    }
  }

  function applyVerdict(task, rt, text) {
    const w = task.watch;
    if (!w) return;
    const verdict = bg.parseVerdict(text);
    w.judgedHash = w.pendingHash || w.judgedHash;
    w.hash = w.pendingHash || w.hash;
    delete w.pendingHash;
    if (verdict.match && !w.holding) {
      w.holding = true;
      announce(task, 'watch', deps.t('tasks.notify.watch', { title: task.title, reason: verdict.reason || task.schedule.condition }));
    } else if (!verdict.match && !verdict.unclear) w.holding = false;
  }

  // ---- startup
  function init() {
    if (started) return;
    started = true;
    const loaded = store.load();
    tasks = loaded.map((t) => bg.recoverAfterRestart(t, now()));
    saveNow();
    const cut = bg.newlyInterrupted(loaded, tasks);
    // One message for all of them, after the window has had time to load.
    if (cut.length) setTimeout(() => announce(cut[0], 'interrupted', deps.t(cut.length === 1 ? 'tasks.notify.interrupted' : 'tasks.notify.interruptedMany', { title: cut[0].title, count: cut.length })), deps.test ? 300 : 2500).unref?.();
    broadcast();
    ticker = setInterval(tick, deps.test ? 500 : 15000);
    ticker.unref?.();
    setTimeout(() => { tick(); }, 1500).unref?.();
    // Routines missed while Lumen was closed run once, after the window has loaded; after the Mac wakes,
    // a few seconds later (the network comes back first). A sleeping Mac's timers don't fire on time.
    armRoutines(deps.test ? 300 : 3000);
    deps.powerMonitor?.()?.on('resume', () => armRoutines(deps.test ? 0 : 5000));
  }

  function shutdown() {
    clearInterval(ticker);
    armRoutines(null);
    saveNow(); // a running task is saved as running: the next start marks it interrupted
    closed = true;
    for (const rt of runtimes.values()) { rt.stopped = true; rt.agent?.stop(); }
  }

  // The "Watch this page" menu item and other entry points: the UI opens its confirmation card.
  function propose(spec) {
    if (!settings().enabled) return false;
    ui()?.send('tasks:propose', spec);
    return true;
  }

  // The app menu's items (main.js spreads these in).
  function menuItems(pageUrl) {
    if (!settings().enabled) return [];
    return [
      { label: deps.t('menu.backgroundRun'), click: () => propose({ prompt: '' }) },
      { label: deps.t('menu.watchPage'), enabled: Boolean(bg.hostOfUrl(pageUrl)), click: () => propose({ watchUrl: pageUrl }) },
      { label: deps.t('menu.backgroundTasks'), click: () => ui()?.send('tasks:open', {}) },
    ];
  }

  // ---- IPC (renderer/tasks.js). All of these answer the browser UI only: main.js lists the channels
  // in UI_ONLY_IPC, so a page, a private window or an extension is refused before they run.
  function register(ipcMain) {
    const ok = (fn) => (_e, ...args) => { try { return { ok: true, ...(fn(...args) || {}) }; } catch (err) { return { ok: false, error: String(err?.message || err) }; } };
    ipcMain.handle('tasks:state', () => state());
    ipcMain.handle('tasks:preview', (_e, spec) => preview(spec || {}));
    ipcMain.handle('tasks:create', ok((spec) => ({ id: createTask(spec || {}).id })));
    ipcMain.handle('tasks:get', (_e, id) => {
      const task = find(id);
      if (!task) return null;
      if (task.unseen && !bg.ACTIVE.has(task.status)) { task.unseen = false; saveSoon(); broadcast(); } // looking at it is seeing it
      return { ...bg.summarize(task, now(), pendingOf(task.id), { queue: bg.queueInfo(tasks, slots(), now())[task.id], waitingSince: runtimes.get(task.id)?.waitingSince || 0 }), prompt: task.prompt, steps: task.steps, result: task.result, runs: task.runs, pages: task.pages || [], ...(task.routine ? { routine: { startUrl: task.routine.startUrl, history: task.routine.history, runs: task.routine.history.length } } : {}) };
    });
    ipcMain.handle('tasks:run', (_e, id, opts) => run(id, { resume: Boolean(opts?.resume) }));
    ipcMain.handle('tasks:edit', (_e, id, patch, opts) => edit(id, patch && typeof patch === 'object' ? { title: patch.title, prompt: patch.prompt, sites: patch.sites } : {}, { andRun: Boolean(opts?.run) }));
    ipcMain.handle('tasks:stop', (_e, id) => stop(id));
    ipcMain.handle('tasks:delete', (_e, id) => remove(id));
    ipcMain.handle('tasks:approve', (_e, id, approvalId, choice) => approve(id, Number(approvalId), ['once', 'site', 'deny'].includes(choice) ? choice : 'deny'));
    ipcMain.handle('tasks:schedule', (_e, id, schedule) => setSchedule(id, schedule));
    ipcMain.handle('tasks:enable', (_e, id, on) => setEnabled(id, on));
    ipcMain.handle('tasks:open-page', (_e, id) => {
      const url = find(id)?.currentUrl || '';
      if (!bg.hostOfUrl(url)) return false;
      deps.openTab(url);
      return true;
    });
    ipcMain.handle('tasks:settings', (_e, patch) => {
      const next = bg.normalizeSettings({ ...settings(), ...(patch && typeof patch === 'object' ? patch : {}) });
      deps.writeSettings({ ...deps.readSettings(), bgTasks: next });
      if (!next.enabled) for (const id of [...runtimes.keys()]) stop(id);
      broadcast();
      pump();
      runRoutines();
      return next;
    });
    ipcMain.handle('routines:save', ok((spec) => ({ id: saveRoutine(spec && typeof spec === 'object' ? spec : {}).id })));
    ipcMain.handle('routines:preview', (_e, spec) => routinePreview(spec && typeof spec === 'object' ? spec : {}));
  }

  return {
    init, shutdown, register, propose, menuItems, state, preview, create: createTask, run, stop, remove, approve, edit, setSchedule, setEnabled, tick, pump, saveNow, saveRoutine, routinePreview, runRoutines,
    // Test hooks (test/bgtasks.js, test/routines.js); nothing in the app itself uses these.
    tasks: () => tasks, notifications: () => notifications, runtimes: () => runtimes, find,
    routineTimer: () => routineTimer, setOnline: (fn) => { onlineCheck = fn; },
  };
}

// The renderer-to-main channels above; main.js lists them in UI_ONLY_IPC.
const CHANNELS = ['tasks:state', 'tasks:preview', 'tasks:create', 'tasks:get', 'tasks:run', 'tasks:edit', 'tasks:stop', 'tasks:delete', 'tasks:approve', 'tasks:schedule', 'tasks:enable', 'tasks:open-page', 'tasks:settings', 'routines:save', 'routines:preview'];

module.exports = { create, TaskAgent, WORK_TAB, RISKY_CLICK, CHANNELS };
