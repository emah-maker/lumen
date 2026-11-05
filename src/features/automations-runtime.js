// Automations: the part that connects automations.js (data, plans, queue) and ai/automation-page.js (the page scripts) to Lumen.
// lumen://automations (renderer/automations.html) is its screen; main.js answers that page's calls through register().
//
// A run takes the automation's items one at a time, each in a tab of its own: an ordinary background tab in a tab group named
// after the automation, so the user can open any of them and take over. For each item:
//   1. the page opens; the automation's steps (a recording or a draft: macro steps, run by macro-runner.js with the AI's own
//      primitives, as a user's macro run is) lead to the form;
//   2. the page script reads the form; a sign-in, a CAPTCHA, no form, or questions with no saved answer make the item
//      "Needs you" (the tab stays open; Continue looks again). Nothing is guessed;
//   3. the profile's answers are filled in, the résumé goes into its file field (the tab's DevTools session, as upload_file does);
//   4. the item waits at Submit with what was filled (Review), unless the automation submits without asking and Lumen is in
//      Bypass permissions (automations.submitsAlone);
//   5. Submit is clicked and the page read again: done, refused (back to Needs you with the page's errors) or unclear (Needs you:
//      the user checks). Each item that ends goes into the tracker.
// While items wait for the user the run goes on with the next ones; it stops starting new ones while LIMITS.waiting wait.
// A scheduled automation starts on its routine-style schedule (routines.nextOccurrence), one timer for all of them.
//
// deps: { file, encrypt, decrypt, available, now, openTab(url, { group, key }) -> { id, webContents } (a background tab; tabs with one key share a group), closeTab(id), switchTab(id),
//   tabById(id) -> { id, webContents } | null, tabLoaded(tab), runSteps(tab, steps, signal) -> { ok, text }, permissionMode() -> 'ask'|'auto'|'bypass',
//   keepTabs() -> boolean, complete({ system, user, schema }), record: { start(), stop() -> { ok, steps } }, pickFile(kind) -> path|'',
//   saveCsv(text) -> { ok, filePath }, projects() -> [{ id, name }], notify({ title, body }), changed() (the page looks again), t(key, params) }
const fs = require('fs');
const path = require('path');
const auto = require('./automations');
const page = require('../ai/automation-page');
const routines = require('./routines');

const SETTLE_MS = 600; // a page's own scripts finish drawing the form
const AFTER_SUBMIT_MS = 12000; // how long a submitted page has to answer
const MAX_SLEEP_MS = 3600000;

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    kind: { type: 'string', enum: ['urls', 'search'] },
    urls: { type: 'array', items: { type: 'string' } },
    search_url: { type: 'string' },
    match: { type: 'string' },
    limit: { type: 'number' },
    schedule: { type: 'string' },
    steps: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['click', 'wait', 'scroll', 'key'] }, element_text: { type: 'string' }, seconds: { type: 'number' }, key: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down'] } }, required: ['type', 'element_text', 'seconds', 'key', 'direction'], additionalProperties: false } },
  },
  required: ['name', 'kind', 'urls', 'search_url', 'match', 'limit', 'schedule', 'steps'],
  additionalProperties: false,
};
const DRAFT_SYSTEM = 'You turn a sentence into a Lumen browser automation that is run on a list of pages, for example job postings to apply to. Fields: name (2-5 words); kind "urls" (urls: the pages named) or "search" (search_url: one page that lists them, match: the words a link to one must have, limit: how many new ones a run, 10 if not said); schedule: when it repeats in plain words ("every weekday at 9am", "every 6 hours"), or "" if not said; steps: only the clicks needed on each page to reach the form (for example click "Apply"), usually none. Lumen fills the form from the user\'s saved profile and stops at Submit for review: never add typing or a Submit click. Use only addresses the user wrote. Unused fields: empty string, empty list or 0. Reply with JSON only.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (err) => String(err?.message || err || 'Something went wrong.').split('\n')[0].slice(0, 300);

function create(deps) {
  const now = deps.now || (() => Date.now());
  const store = auto.createStore({ file: deps.file, encrypt: deps.encrypt, decrypt: deps.decrypt, available: deps.available, now });
  const active = new Map(); // run id -> { run, automation, profile, tabs: Map(itemId -> tabId), work: Map(itemId -> { plan, scan, submitRef, before }), controller, busy }
  let scheduleTimer = null;
  let changeTimer = null;
  const t = (key, params) => (deps.t ? deps.t(key, params) : key);

  const changed = () => {
    if (changeTimer) return;
    changeTimer = setTimeout(() => { changeTimer = null; try { deps.changed?.(); } catch { /* the page looks again later */ } }, 60);
  };
  const save = () => { try { store.write(); } catch (err) { console.error('[lumen] could not save automations:', err.message); } };
  const tabOf = (ctx, item) => { const id = ctx.tabs.get(item.id); return id == null ? null : deps.tabById(id); };
  const wcOf = (tab) => (tab?.webContents && !tab.webContents.isDestroyed() ? tab.webContents : null);
  const inPage = async (tab, code) => {
    const wc = wcOf(tab);
    if (!wc) throw new Error(t('automations.error.tabClosed'));
    return wc.executeJavaScriptInIsolatedWorld(page.WORLD, [{ code }]);
  };

  // ---- the state the page shows
  function summary(a) {
    const run = [...active.values()].find((x) => x.automation.id === a.id)?.run || null;
    let nextRun = null;
    if (a.schedule && a.scheduleOn) nextRun = routines.nextOccurrence(a.schedule, Math.max(a.lastDue || 0, a.updatedAt || 0, now() - 1));
    return { ...a, nextRun, runningId: run && (run.state === 'running' || run.state === 'paused') ? run.id : null };
  }
  function runView(run) {
    return { ...run, counts: auto.counts(run), live: active.has(run.id), items: run.items.map((i) => ({ ...i, hasTab: active.has(run.id) && active.get(run.id).tabs.has(i.id) })) };
  }
  function state() {
    return {
      automations: store.automations().map(summary),
      profiles: store.profiles(),
      runs: [...store.runs()].reverse().map(runView),
      log: store.log().slice(-200).reverse(),
      logCount: store.log().length,
      mode: deps.permissionMode?.() || 'ask',
      keychain: Boolean(deps.available?.()),
      unreadable: store.unreadable(),
      projects: (() => { try { return (deps.projects?.() || []).map((p) => ({ id: p.id, name: p.name })); } catch { return []; } })(),
      profileKeys: auto.PROFILE_KEYS,
    };
  }

  // ---- a run
  async function start(id, { trigger = 'manual' } = {}) {
    const automation = store.automation(id);
    if (!automation) return { ok: false, error: t('automations.error.gone') };
    if ([...active.values()].some((x) => x.automation.id === id && (x.run.state === 'running' || x.run.state === 'paused'))) return { ok: false, error: t('automations.error.running') };
    const profile = store.profile(automation.profileId) || null;
    if (!profile) return { ok: false, error: t('automations.error.noProfile') };
    let items;
    const done = automation.inputs.skipDone ? auto.doneKeys(store.log()) : new Set();
    if (automation.inputs.kind === 'search') {
      if (!automation.inputs.searchUrl) return { ok: false, error: t('automations.error.noSearch') };
      let links;
      try { links = await searchLinks(automation); } catch (err) { return { ok: false, error: errText(err) }; }
      items = auto.itemsFor(automation, { links: auto.pickLinks(links, { base: automation.inputs.searchUrl, match: automation.inputs.match, limit: automation.inputs.limit, done }), done });
    } else items = auto.itemsFor(automation, { done });
    const run = auto.newRun(automation, items, { now: now(), trigger });
    automation.lastRunAt = now();
    store.addRun(run);
    if (!items.length) { run.state = 'finished'; run.endedAt = now(); run.error = t('automations.run.nothing'); save(); changed(); return { ok: true, runId: run.id, empty: true }; }
    active.set(run.id, { run, automation, profile, tabs: new Map(), work: new Map(), controller: null, busy: false });
    save();
    changed();
    pump(run.id);
    return { ok: true, runId: run.id };
  }

  // A search page's links, read in a background tab that is closed again.
  async function searchLinks(automation) {
    const tab = deps.openTab(automation.inputs.searchUrl);
    try {
      await deps.tabLoaded(tab);
      await sleep(SETTLE_MS);
      return await inPage(tab, page.linksSource());
    } finally { try { deps.closeTab(tab.id); } catch { /* gone */ } }
  }

  function pump(runId) {
    const ctx = active.get(runId);
    if (!ctx || ctx.busy) return;
    const item = auto.nextItem(ctx.run);
    if (!item) { finishIfOver(ctx); return; }
    ctx.busy = true;
    ctx.controller = new AbortController();
    const signal = ctx.controller.signal;
    processItem(ctx, item, signal).catch((err) => fail(ctx, item, err)).finally(() => {
      ctx.busy = false;
      ctx.controller = null;
      save();
      changed();
      setTimeout(() => pump(runId), 0);
    });
  }

  function finishIfOver(ctx) {
    if (!auto.settle(ctx.run, now())) return;
    active.delete(ctx.run.id);
    save();
    changed();
    const c = auto.counts(ctx.run);
    deps.notify?.({ title: ctx.automation.name, body: t('automations.notify.finished', { done: c.done, total: c.total }) });
  }

  function fail(ctx, item, err) {
    if (auto.FINAL.has(item.status)) return;
    if (item.status === 'running' || item.status === 'needs-you') auto.moveItem(ctx.run, item.id, 'failed', { note: errText(err) }, now());
    end(ctx, item);
  }

  // An item is over: into the tracker, and its tab closed (unless the user keeps them, or it still has something to look at).
  function end(ctx, item) {
    store.addLog(auto.logEntry(ctx.run, item, ctx.automation, { now: now() }));
    ctx.work.delete(item.id);
    const tabId = ctx.tabs.get(item.id);
    if (tabId != null && !(deps.keepTabs?.() || item.status === 'failed')) { try { deps.closeTab(tabId); } catch { /* gone */ } ctx.tabs.delete(item.id); }
    save();
  }

  function wait(ctx, item, to, patch) {
    const before = auto.counts(ctx.run);
    if (!auto.moveItem(ctx.run, item.id, to, patch, now())) return;
    // One notification when the run starts waiting for the user, not one per item.
    if (!before.review && !before['needs-you']) deps.notify?.({ title: ctx.automation.name, body: t(to === 'review' ? 'automations.notify.review' : 'automations.notify.needs', { title: item.role || item.url }) });
  }

  async function processItem(ctx, item, signal) {
    auto.moveItem(ctx.run, item.id, 'running', { note: '' }, now());
    changed();
    const tab = deps.openTab(item.url, { group: ctx.automation.name, key: ctx.run.id }); // (the run's tabs share a group named after it)
    ctx.tabs.set(item.id, tab.id);
    await deps.tabLoaded(tab);
    if (signal.aborted) return;
    if (ctx.automation.steps.length) {
      const r = await deps.runSteps(tab, ctx.automation.steps, signal);
      if (signal.aborted) return;
      if (!r?.ok) { wait(ctx, item, 'needs-you', { need: 'step', note: String(r?.text || '').slice(0, 300) }); return; }
      await deps.tabLoaded(tab);
    }
    await examine(ctx, item, tab, signal);
  }

  // Reads the form, fills what has an answer, and moves the item to Review, Needs you, or (submitting alone) on to Submit.
  async function examine(ctx, item, tab, signal, { again = false } = {}) {
    await sleep(SETTLE_MS);
    if (signal?.aborted) return;
    let scan = await inPage(tab, page.scanSource());
    if (!scan?.fields?.length && scan?.embeds?.length && !again) {
      // The form is a job board's page inside this one (Greenhouse, Lever…): its own address is opened in the tab instead.
      const wc = wcOf(tab);
      await wc.loadURL(scan.embeds[0]).catch(() => {});
      await deps.tabLoaded(tab);
      await sleep(SETTLE_MS);
      scan = await inPage(tab, page.scanSource());
    }
    const job = auto.jobOf({ ...scan?.page, url: scan?.url || item.url });
    item.role = item.role || job.role;
    item.company = item.company || job.company;
    const plan = auto.planFill(scan?.fields || [], ctx.profile, { company: item.company, role: item.role, fileFields: scan?.fileFields || 0 });
    const blocker = auto.blockerOf(scan, plan);
    if (blocker === 'login' || blocker === 'captcha' || blocker === 'noform') { wait(ctx, item, 'needs-you', { need: blocker, questions: [] }); return; }
    const text = plan.fills.filter((f) => f.kind !== 'file');
    const results = text.length ? await inPage(tab, page.fillSource(text)) : [];
    const failed = new Set((results || []).filter((r) => !r.ok).map((r) => r.ref));
    for (const f of plan.fills.filter((x) => x.kind === 'file')) {
      try { await setFile(tab, f.ref, f.value); } catch (err) { failed.add(f.ref); item.note = errText(err); }
    }
    const filled = auto.preview({ ...plan, fills: plan.fills.filter((f) => !failed.has(f.ref)) }).filter((r) => r.kind !== 'missing');
    item.filled = again ? mergeFilled(item.filled, filled) : filled;
    const missing = [...plan.unknown, ...plan.fills.filter((f) => failed.has(f.ref)).map((f) => ({ ref: f.ref, label: f.label, required: true, file: f.kind === 'file' }))];
    if (missing.length) { wait(ctx, item, 'needs-you', { need: missing.every((m) => m.file) ? 'file' : 'questions', questions: missing.map((m) => m.label).slice(0, 20) }); return; }
    const submitRef = (ctx.automation.submit ? await inPage(tab, page.findSource(ctx.automation.submit)) : '') || scan.submit?.ref || '';
    if (!submitRef) { wait(ctx, item, 'needs-you', { need: 'nosubmit', questions: [] }); return; }
    ctx.work.set(item.id, { plan, submitRef, submitText: scan.submit?.text || '' });
    if (auto.submitsAlone(ctx.automation, deps.permissionMode?.())) { await submit(ctx, item, tab); return; }
    wait(ctx, item, 'review', { need: '', questions: [] });
  }
  const mergeFilled = (old, fresh) => { const by = new Map((old || []).map((r) => [r.label, r])); for (const r of fresh) by.set(r.label, r); return [...by.values()]; };

  // The résumé (or cover letter) into a file field, through the tab's DevTools session (the field is found by its ref).
  async function setFile(tab, ref, filePath) {
    if (!filePath || !fs.existsSync(filePath)) throw new Error(t('automations.error.noFile', { name: path.basename(String(filePath || '')) }));
    const wc = wcOf(tab);
    const dbg = wc.debugger;
    const attachedHere = !dbg.isAttached();
    if (attachedHere) dbg.attach('1.3');
    try {
      const { result } = await dbg.sendCommand('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(page.fileSelector(ref))})`, returnByValue: false });
      if (!result?.objectId) throw new Error(t('automations.error.fieldGone'));
      await dbg.sendCommand('DOM.setFileInputFiles', { files: [filePath], objectId: result.objectId });
      dbg.sendCommand('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
    } finally { if (attachedHere) { try { dbg.detach(); } catch { /* gone */ } } }
  }

  async function submit(ctx, item, tab) {
    const work = ctx.work.get(item.id);
    if (!work) return;
    auto.moveItem(ctx.run, item.id, 'running', {}, now());
    changed();
    const before = await inPage(tab, page.checkSource()).catch(() => null);
    const wc = wcOf(tab);
    const navigated = new Promise((resolve) => {
      const done = () => { clearTimeout(timer); wc.removeListener('did-stop-loading', done); resolve(); };
      const timer = setTimeout(done, AFTER_SUBMIT_MS);
      wc.once('did-stop-loading', done);
    });
    const clicked = await inPage(tab, page.clickSource(work.submitRef));
    if (!clicked) { wait(ctx, item, 'needs-you', { need: 'nosubmit' }); return; }
    // The page answers by loading another page, or in place: whichever comes first, then a moment for it to draw.
    await Promise.race([navigated, (async () => { for (let i = 0; i < AFTER_SUBMIT_MS / 400; i++) { await sleep(400); const c = await inPage(tab, page.checkSource()).catch(() => null); if (auto.outcome(before, c) !== 'check') return; } })()]);
    await sleep(SETTLE_MS);
    const after = await inPage(tab, page.checkSource()).catch(() => null);
    const result = auto.outcome(before, after);
    if (result === 'done') {
      auto.moveItem(ctx.run, item.id, 'done', { submittedAt: now(), need: '', note: '' }, now());
      end(ctx, item);
      return;
    }
    if (result === 'rejected') { wait(ctx, item, 'needs-you', { need: 'rejected', questions: [...(after?.invalid || []), ...(after?.alerts || [])].slice(0, 10) }); return; }
    wait(ctx, item, 'needs-you', { need: 'check', questions: [] });
  }

  // ---- what the user does on the run screen
  function itemAct({ op, runId, itemId } = {}) {
    const ctx = active.get(String(runId));
    const run = ctx?.run || store.runs().find((r) => r.id === String(runId));
    const item = run?.items.find((i) => i.id === String(itemId));
    if (!run || !item) return { ok: false };
    const live = Boolean(ctx);
    const tab = live ? tabOf(ctx, item) : null;
    if (op === 'open') { if (!tab) return { ok: false, error: t('automations.error.tabClosed') }; deps.switchTab(tab.id); return { ok: true }; }
    if (!live) return { ok: false, error: t('automations.error.notLive') };
    const after = () => { save(); changed(); setTimeout(() => pump(run.id), 0); };
    if (op === 'approve') {
      if (item.status !== 'review' || !tab || ctx.busy) return { ok: false };
      ctx.busy = true;
      submit(ctx, item, tab).catch((err) => fail(ctx, item, err)).finally(() => { ctx.busy = false; after(); });
      return { ok: true };
    }
    if (op === 'continue') {
      if ((item.status !== 'needs-you' && item.status !== 'review') || !tab || ctx.busy) return { ok: false };
      ctx.busy = true;
      auto.moveItem(run, item.id, 'running', { need: '', questions: [] }, now());
      examine(ctx, item, tab, null, { again: true }).catch((err) => fail(ctx, item, err)).finally(() => { ctx.busy = false; after(); });
      return { ok: true };
    }
    if (op === 'done') { // the user submitted it themselves (or it went through and Lumen couldn't tell)
      if (item.status !== 'needs-you' && item.status !== 'review') return { ok: false };
      if (!auto.moveItem(run, item.id, 'done', { submittedAt: now(), need: '', note: t('automations.note.byUser') }, now())) return { ok: false };
      end(ctx, item);
      after();
      return { ok: true };
    }
    if (op === 'skip') {
      if (item.status === 'running' && ctx.busy) ctx.controller?.abort();
      if (!auto.moveItem(run, item.id, 'skipped', {}, now())) return { ok: false };
      end(ctx, item);
      after();
      return { ok: true };
    }
    if (op === 'retry') {
      if (!auto.moveItem(run, item.id, 'queued', {}, now())) return { ok: false };
      if (ctx.tabs.has(item.id)) { try { deps.closeTab(ctx.tabs.get(item.id)); } catch { /* gone */ } ctx.tabs.delete(item.id); }
      after();
      return { ok: true };
    }
    return { ok: false };
  }

  function runAct({ op, runId } = {}) {
    const ctx = active.get(String(runId));
    if (!ctx) return { ok: false, error: t('automations.error.notLive') };
    if (op === 'pause') { const ok = auto.pauseRun(ctx.run); save(); changed(); return { ok }; }
    if (op === 'resume') { const ok = auto.resumeRun(ctx.run); save(); changed(); pump(ctx.run.id); return { ok }; }
    if (op === 'stop') {
      ctx.controller?.abort();
      for (const item of ctx.run.items) if (!auto.FINAL.has(item.status)) { item.status = 'stopped'; item.endedAt = now(); store.addLog(auto.logEntry(ctx.run, item, ctx.automation, { now: now() })); }
      auto.stopRun(ctx.run, now());
      if (!deps.keepTabs?.()) for (const id of ctx.tabs.values()) { try { deps.closeTab(id); } catch { /* gone */ } }
      active.delete(ctx.run.id);
      save();
      changed();
      return { ok: true };
    }
    return { ok: false };
  }

  // ---- making one: from a sentence, from a recording
  async function describe(text) {
    const sentence = String(text ?? '').trim().slice(0, 2000);
    if (!sentence) return { ok: false, error: t('automations.error.describe') };
    const fallback = auto.draftFromText(sentence);
    if (!deps.complete) return { ok: true, draft: fallback, byModel: false };
    try {
      const raw = await deps.complete({ system: DRAFT_SYSTEM, user: `Make an automation for: ${sentence}`, schema: DRAFT_SCHEMA });
      const written = new Set(auto.urlsIn(sentence).map(auto.urlKey)); // only addresses the user wrote: a model's invented one is dropped
      const keep = (u) => auto.webUrl(u) && written.has(auto.urlKey(u));
      let schedule = null;
      if (raw?.schedule) { const p = routines.parseScheduleText(String(raw.schedule)); try { schedule = p ? auto.normalizeSchedule(p.schedule, now()) : null; } catch { schedule = null; } }
      const steps = (Array.isArray(raw?.steps) ? raw.steps : []).map((s) => (s.type === 'click' ? { type: 'click', locator: { name: s.element_text, text: s.element_text } } : s.type === 'wait' ? { type: 'wait', mode: 'seconds', seconds: s.seconds || 1 } : s.type === 'key' ? { type: 'key', key: s.key } : { type: 'scroll', direction: s.direction || 'down' }));
      const draft = {
        name: String(raw?.name || fallback.name).slice(0, 80),
        description: sentence,
        inputs: auto.normalizeInputs(raw?.kind === 'search' && keep(raw.search_url) ? { kind: 'search', searchUrl: raw.search_url, match: raw.match, limit: raw.limit } : { kind: 'urls', urls: (raw?.urls || []).filter(keep) }),
        steps: auto.normalizeSteps(steps).steps || [],
        schedule: schedule || fallback.schedule,
        scheduleOn: Boolean(schedule || fallback.schedule),
        submitMode: 'review',
      };
      if (draft.inputs.kind === 'urls' && !draft.inputs.urls.length) draft.inputs = fallback.inputs;
      return { ok: true, draft, byModel: true };
    } catch {
      return { ok: true, draft: fallback, byModel: false };
    }
  }

  let recording = false;
  async function recordStart() {
    if (recording) return { ok: false, error: t('automations.error.recording') };
    const r = await deps.record.start();
    if (r?.ok) recording = true;
    return r;
  }
  async function recordStop() {
    if (!recording) return { ok: false };
    recording = false;
    const r = await deps.record.stop();
    if (!r?.ok) return r || { ok: false };
    const parts = auto.fromRecording(r.steps || []);
    return { ok: true, steps: parts.steps, submit: parts.submit, learned: parts.learned, startUrl: parts.startUrl };
  }

  // ---- schedules: one timer, for the soonest scheduled automation
  function armSchedule() {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
    let soonest = Infinity;
    for (const a of store.automations()) {
      if (!a.schedule || !a.scheduleOn) continue;
      const at = routines.nextOccurrence(a.schedule, Math.max(a.lastDue || 0, a.updatedAt || 0));
      if (at !== null && at < soonest) soonest = at;
    }
    if (soonest === Infinity) return;
    scheduleTimer = setTimeout(runDue, Math.min(MAX_SLEEP_MS, Math.max(1000, soonest - now())));
    scheduleTimer.unref?.();
  }
  // Every scheduled automation that is due runs once, however many of its times went by (Lumen closed, the computer asleep).
  function runDue() {
    const t0 = now();
    for (const a of store.automations()) {
      if (!a.schedule || !a.scheduleOn) continue;
      const at = routines.nextOccurrence(a.schedule, Math.max(a.lastDue || 0, a.updatedAt || 0));
      if (at === null || at > t0) continue;
      a.lastDue = t0;
      start(a.id, { trigger: 'schedule' }).catch(() => {});
    }
    save();
    armSchedule();
  }

  // ---- the page's calls
  function saveAutomation(input) {
    const r = store.saveAutomation(input);
    if (r.ok) { armSchedule(); changed(); }
    return r;
  }
  function removeAutomation(id) {
    for (const ctx of active.values()) if (ctx.automation.id === id) runAct({ op: 'stop', runId: ctx.run.id });
    const ok = store.removeAutomation(String(id));
    armSchedule();
    changed();
    return { ok };
  }
  function saveProfile(input) { const r = store.saveProfile(input); if (r.ok) changed(); return r; }
  function removeProfile(id) { const ok = store.removeProfile(String(id)); changed(); return { ok }; }
  async function exportCsv() { return deps.saveCsv(auto.toCsv(store.log())); }
  function clearLog() { store.clearLog(); changed(); return { ok: true }; }

  function init() { store.load(); armSchedule(); }
  function shutdown() {
    clearTimeout(scheduleTimer);
    for (const ctx of active.values()) { ctx.controller?.abort(); auto.stopRun(ctx.run, now()); }
    active.clear();
    save();
  }

  return {
    init, shutdown, state, start, itemAct, runAct, describe, recordStart, recordStop, saveAutomation, removeAutomation, saveProfile, removeProfile, exportCsv, clearLog,
    pickFile: (kind) => deps.pickFile(kind), runDue, armSchedule,
    // Test hooks (test/e2e/automations.js): nothing in the app itself uses these.
    store, active: () => active, scheduleTimer: () => scheduleTimer,
  };
}

// The page's channels (main.js checks each call came from the lumen://automations tab).
const CHANNELS = ['automations:state', 'automations:save', 'automations:delete', 'automations:run', 'automations:run-act', 'automations:item', 'automations:describe', 'automations:record-start', 'automations:record-stop', 'automations:profile-save', 'automations:profile-delete', 'automations:pick-file', 'automations:export', 'automations:clear-log'];

module.exports = { create, CHANNELS, DRAFT_SCHEMA };
