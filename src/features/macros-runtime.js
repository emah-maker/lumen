// Macros: the part that connects macros.js (data) and macro-runner.js (sequencing) to Lumen: the IPC
// handlers (Settings > Macros, the sidebar's /macro, the progress toast), runs started by the user
// (menu, shortcut, slash command, test run) and by the AI (the run_macro tool), and the recorder.
//
// A user's run executes inside agent.inTask(tab, ...) with { userRun: true }: the AI's primitives do
// the work, but the AI-specific limits (hands-off mode, per-site AI off) do not apply, because the
// user wrote the steps. The AI's run keeps its own scope, so every step goes through the same
// approval gate the AI's own actions use (agent.allowStep), plus a card for a step that submits.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const macros = require('./macros');
const { runMacro } = require('./macro-runner');
const macroPage = require('../ai/macro-page');

const RECORD_WORLD = 1051;
const POLL_MS = 350;
const NAV_QUIET_MS = 2000; // a page change within this long of a click or key is that click's doing, not a step of its own
const MAX_NAMES = 40;

const summary = (m) => ({ id: m.id, name: m.name, description: m.description, shortcut: m.shortcut, site: m.site, steps: m.steps.length, variables: macros.variablesOf(m) });

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['open_url', 'click', 'type', 'key', 'wait', 'scroll', 'select', 'tab', 'action', 'ask_ai', 'pause'] },
          url: { type: 'string' }, target: { type: 'string', enum: ['new', 'current'] },
          element_text: { type: 'string' }, text: { type: 'string' }, enter: { type: 'boolean' }, option: { type: 'string' },
          key: { type: 'string' }, seconds: { type: 'number' }, direction: { type: 'string', enum: ['up', 'down'] },
          action: { type: 'string' }, prompt: { type: 'string' }, note: { type: 'string' },
        },
        required: ['type', 'url', 'target', 'element_text', 'text', 'enter', 'option', 'key', 'seconds', 'direction', 'action', 'prompt', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'description', 'steps'],
  additionalProperties: false,
};
const DRAFT_SYSTEM = `You turn a sentence into a Lumen browser macro: a short list of steps. Step types: open_url (url, target new|current), click (element_text: the visible text or label of the thing to click), type (element_text: the field's label or placeholder; text; enter true to press Enter after), select (element_text, option), key (key like Enter or Escape), wait (seconds), scroll (direction), tab (action switch|close), action (one of ${macros.ACTIONS.join(', ')}), ask_ai (prompt), pause (note: when the user must do something, like signing in). Put {{name}} where a value should be asked at run time (for example {{query}}); {{clipboard}}, {{selection}}, {{url}}, {{date}} are filled in by Lumen. Never write passwords, card numbers or one-time codes: use a pause step so the user types them. Use the fewest steps. Unused fields: empty string, false or 0. Reply with JSON only.`;

// What the model drafted -> the editor's macro (steps from the flat shape; bad steps dropped).
function draftFromModel(raw) {
  const steps = (Array.isArray(raw?.steps) ? raw.steps : []).map((s) => {
    const loc = s.element_text ? { name: s.element_text, text: s.element_text } : undefined;
    switch (s.type) {
      case 'open_url': return { type: 'open_url', url: s.url, target: s.target };
      case 'click': return { type: 'click', locator: loc };
      case 'type': return { type: 'type', locator: loc, text: s.text, enter: s.enter };
      case 'select': return { type: 'select', locator: loc, option: s.option };
      case 'key': return { type: 'key', key: s.key };
      case 'wait': return { type: 'wait', mode: 'seconds', seconds: s.seconds || 1 };
      case 'scroll': return { type: 'scroll', direction: s.direction };
      case 'tab': return { type: 'tab', action: s.action === 'close' ? 'close' : 'switch', which: 'next' };
      case 'action': return { type: 'action', action: s.action, name: s.text, text: s.text };
      case 'ask_ai': return { type: 'ask_ai', prompt: s.prompt };
      case 'pause': return { type: 'pause', note: s.note };
      default: return { type: s.type };
    }
  });
  return macros.normalizeMacro({ name: raw?.name || 'New macro', description: raw?.description, steps }, { strict: false });
}

// deps: { ipcMain, dialog, win(), file, documentsDir(), agent, send(channel, payload) (the UI window),
//   broadcast(channel, payload) (the UI and the Settings tabs), target() -> tab|null (where a run or a recording acts: the
//   front web tab, else the last one), tabList() -> [{id,url,title,active}], openTab(url) -> tab, switchTab(id), tabLoaded(tab),
//   actions: { [name]: (args, tab) => string }, clipboardText(), readSelection(wc), openSettings(section), emitTo(channel, payload),
//   complete({system,user,schema}), sidebar(text, { send, newChat }), isTest }
function create(deps) {
  const store = macros.createStore({ file: deps.file });
  const runs = new Map(); // run id -> { controller, name, resume }
  let recording = null;
  let pendingImport = null;
  let pendingDraft = null;
  const platform = deps.platform || process.platform;

  const changed = () => deps.broadcast?.('macros:changed', store.list().map(summary));

  // ---------- progress, stop, continue ----------
  const emit = (runId, event) => { deps.send?.('macros:progress', { runId, ...event }); deps.emitTo?.('macros:progress', { runId, ...event }); }; // the toast, and a Settings page showing a test run
  function begin(macro, source, outer) {
    const runId = crypto.randomBytes(5).toString('hex');
    const controller = new AbortController();
    const run = { runId, macro, source, controller, resume: null };
    runs.set(runId, run);
    if (outer) outer.addEventListener?.('abort', () => controller.abort(), { once: true });
    return run;
  }
  const finish = (run, result) => {
    runs.delete(run.runId);
    emit(run.runId, { phase: result.ok ? 'done' : result.stopped ? 'stopped' : 'failed', macro: run.macro.name, macroId: run.macro.id, total: result.total, index: result.done, ...(result.failed ? { index: result.failed.index, label: result.failed.label, error: result.failed.error } : {}), final: true });
  };
  const pauser = (run) => (note) => new Promise((resolve) => {
    run.resume = (go) => { run.resume = null; resolve(go); };
    run.controller.signal.addEventListener('abort', () => run.resume?.(false), { once: true });
    emit(run.runId, { phase: 'pause', macro: run.macro.name, macroId: run.macro.id, label: note, total: run.macro.steps.length });
  });
  const builtins = (tab) => async (names) => {
    const out = {};
    const wc = tab?.webContents || tab?.view?.webContents;
    if (names.includes('clipboard')) out.clipboard = String((await deps.clipboardText?.()) || '').slice(0, 20000);
    if (wc && !wc.isDestroyed()) {
      if (names.includes('url')) out.url = wc.getURL();
      if (names.includes('title')) out.title = wc.getTitle();
      if (names.includes('selection')) out.selection = String((await deps.readSelection?.(wc).catch(() => '')) || '').slice(0, 20000);
    }
    return out;
  };

  // One of Lumen's own commands (deps.actions); one that opens a tab moves the run's tab there, as open_tab does.
  async function runAction(name, args, tab) {
    if (!deps.actions[name]) throw new Error(`Unknown Lumen action ${name}.`);
    const out = await deps.actions[name](args, tab);
    if (out && typeof out === 'object') { if (out.pinTab != null) deps.agent.pinTab(out.pinTab); return out.text || 'Done.'; }
    return out || 'Done.';
  }

  // ---------- a run the user started (menu, shortcut, slash command, Settings test run) ----------
  // -> { ok, message?, asking?, runId?, result? }. A macro that needs values the caller did not give asks for them in a card.
  async function runForUser(query, { values = {}, source = 'menu' } = {}) {
    const found = typeof query === 'object' && query ? { macro: query } : macros.findMacro(store.list(), query);
    if (!found.macro) return { ok: false, message: found.ambiguous ? `Which one? ${found.ambiguous.slice(0, 6).join(', ')}` : 'No macro by that name. Create one in Settings > Macros.' };
    const macro = found.macro;
    const tab = deps.target();
    if (!tab) return { ok: false, message: 'Open a web page first.' };
    const wc = tab.webContents || tab.view?.webContents;
    if (!macros.siteMatches(macro.site, wc.getURL())) return { ok: false, message: `This macro only runs on ${macro.site}.` };
    const needs = macros.variablesOf(macro).filter((v) => values[v] == null || values[v] === '');
    if (needs.length) { deps.send?.('macros:vars', { id: macro.id, name: macro.name, description: macro.description, vars: needs, source }); return { ok: false, asking: true }; }
    if ([...runs.values()].some((r) => r.source !== 'ai')) return { ok: false, message: 'A macro is already running. Stop it first.' };
    const run = begin(macro, source);
    emit(run.runId, { phase: 'start', macro: macro.name, macroId: macro.id, total: macro.steps.length });
    const result = await deps.agent.inTask(tab.id, run.controller.signal, () => runMacro(macro, {
      values,
      mode: 'user',
      deps: {
        tool: (name, input) => deps.agent.execute(name, input),
        resolve: (locator) => deps.agent.macroResolve(locator),
        openTab: async (url) => { const t = deps.openTab(url); deps.agent.pinTab(t.id); await deps.tabLoaded(t); return 'Opened.'; },
        tabs: async () => deps.tabList(),
        action: async (name, args) => runAction(name, args, deps.agent.taskTab?.() || tab),
        askAI: async (text, opts) => { deps.sidebar?.(text, { send: true, newChat: opts?.newChat }); return 'Sent to the sidebar.'; },
        pause: pauser(run),
        builtins: builtins(tab),
        progress: (e) => emit(run.runId, { ...e, macroId: macro.id }),
        aborted: () => run.controller.signal.aborted,
      },
    }), null, null, { userRun: true }).catch((err) => ({ ok: false, done: 0, total: macro.steps.length, failed: { index: 1, label: '', error: String(err?.message || err) }, text: String(err?.message || err) }));
    finish(run, result);
    return { ok: result.ok, runId: run.runId, result, message: result.ok ? '' : result.text };
  }

  // ---------- a run the AI asked for (the run_macro tool), inside its own task scope ----------
  // input: { name, variables, list }. Returns text for the model.
  async function runForAI(input, agent) {
    const all = store.list();
    if (input.list === true || (!input.name && !input.id)) {
      if (!all.length) return 'The user has no saved macros.';
      return all.slice(0, MAX_NAMES).map((m) => `${m.name}${m.description ? `: ${m.description}` : ''}${macros.variablesOf(m).length ? ` (variables: ${macros.variablesOf(m).join(', ')})` : ''}${m.site ? ` [only on ${m.site}]` : ''}`).join('\n');
    }
    const found = macros.findMacro(all, input.name || input.id);
    if (!found.macro) return found.ambiguous ? `Several macros match: ${found.ambiguous.join(', ')}. Use the full name.` : `No macro named “${String(input.name).slice(0, 60)}”. Call run_macro with list:true to see them.`;
    const macro = found.macro;
    if (!macros.siteMatches(macro.site, agent.taskTabUrl())) throw new Error(`The macro “${macro.name}” only runs on ${macro.site}.`);
    const values = {};
    for (const [k, v] of Object.entries(input.variables && typeof input.variables === 'object' ? input.variables : {})) if (typeof v === 'string' || typeof v === 'number') values[k] = String(v).slice(0, 2000);
    const scope = agent.currentScope?.();
    const run = begin(macro, 'ai', scope?.signal);
    emit(run.runId, { phase: 'start', macro: macro.name, macroId: macro.id, total: macro.steps.length });
    const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
    const result = await runMacro(macro, {
      values,
      mode: 'ai',
      deps: {
        tool: (name, i) => agent.execute(name, i),
        allow: (name, i) => agent.allowStep(name, i),
        confirm: ({ label, reason }) => agent.macroConfirm(label, reason, hostOf(agent.taskTabUrl())),
        resolve: (locator) => agent.macroResolve(locator),
        tabs: async () => JSON.parse(await agent.execute('list_tabs', {})).filter((t) => t.url).map((t) => ({ id: t.id, url: t.url, title: t.title || '', active: Boolean(t.active) })),
        action: async (name, args) => {
          agent.handsOffCheck('click', {}); // an action changes the user's tab like a click does
          agent.offTabCheck('click', {});
          return runAction(name, args, agent.taskTab());
        },
        pause: pauser(run),
        builtins: builtins(agent.taskTab()),
        progress: (e) => emit(run.runId, { ...e, macroId: macro.id }),
        aborted: () => run.controller.signal.aborted || Boolean(scope?.signal?.aborted),
      },
    });
    finish(run, result);
    if (result.needs) return `${result.text} Call run_macro again with variables {${result.needs.map((n) => `"${n}": "…"`).join(', ')}}.`;
    if (!result.ok && result.failed) throw new Error(result.text);
    return result.text;
  }

  // ---------- recording ----------
  const inWorld = (wc, code) => wc.executeJavaScriptInIsolatedWorld(RECORD_WORLD, [{ code }]);
  async function startRecording() {
    if (recording) return { ok: false, error: 'Already recording.' };
    const tab = deps.target() || deps.openTab(); // (no web page to record on: a new tab)
    const wc = tab.webContents || tab.view?.webContents;
    deps.switchTab?.(tab.id);
    const rec = { tabId: tab.id, events: [], startUrl: /^https?:/i.test(wc.getURL()) ? wc.getURL() : '', lastInputAt: 0, timer: null, attached: new Map(), busy: false };
    recording = rec;
    const attach = (t) => {
      const w = t.webContents || t.view?.webContents;
      if (!w || w.isDestroyed() || rec.attached.has(t.id)) return;
      const onNav = (_e, url, _inPlace, isMainFrame) => {
        if (isMainFrame === false || !/^https?:/i.test(url) || Date.now() - rec.lastInputAt < NAV_QUIET_MS) return;
        if (rec.events[rec.events.length - 1]?.url === url && rec.events[rec.events.length - 1]?.type === 'nav') return;
        rec.events.push({ type: 'nav', url });
      };
      w.on('did-navigate', onNav);
      rec.attached.set(t.id, { w, onNav });
    };
    attach(tab);
    const install = async (w) => { try { await inWorld(w, macroPage.recorderSource()); } catch { /* the page is loading: the next tick tries again */ } };
    await install(wc);
    const tick = async () => {
      if (recording !== rec || rec.busy) return;
      rec.busy = true;
      try {
        const active = deps.target();
        if (active && active.id !== rec.tabId) {
          // The user moved to another tab (or a click opened one): note it as a step and follow them there.
          const now = active.webContents || active.view?.webContents;
          let match = '';
          try { const u = new URL(now.getURL()); match = u.hostname + (u.pathname.length > 1 ? u.pathname : ''); } catch { /* not a web page */ }
          if (!match) match = now.getTitle().slice(0, 60);
          if (match) rec.events.push({ type: 'tab', match });
          rec.tabId = active.id;
          attach(active);
        }
        const cur = deps.tabById?.(rec.tabId) || deps.target();
        const w = cur && (cur.webContents || cur.view?.webContents);
        if (w && !w.isDestroyed()) {
          let got = null;
          try { got = await inWorld(w, macroPage.drainSource()); } catch { got = null; }
          if (got === null) await install(w); // a new page (the world was reset): listen again
          else if (Array.isArray(got) && got.length) { rec.lastInputAt = Date.now(); rec.events.push(...got); }
        }
        deps.send?.('macros:recording', { on: true, steps: macros.stepsFromRecording(rec.events, { startUrl: rec.startUrl }).steps.length });
      } finally { rec.busy = false; }
    };
    rec.timer = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
    rec.timer.unref?.();
    deps.send?.('macros:recording', { on: true, steps: 0 });
    return { ok: true };
  }
  async function stopRecording({ cancel = false } = {}) {
    const rec = recording;
    if (!rec) return { ok: false, error: 'Not recording.' };
    clearInterval(rec.timer);
    for (const [id, { w, onNav }] of rec.attached) {
      if (w.isDestroyed()) continue;
      w.removeListener('did-navigate', onNav);
      if (!cancel) { try { const got = await inWorld(w, macroPage.drainSource()); if (Array.isArray(got)) rec.events.push(...got); } catch { /* gone */ } }
      try { await inWorld(w, macroPage.stopSource()); } catch { /* gone */ }
      void id;
    }
    recording = null;
    deps.send?.('macros:recording', { on: false });
    if (cancel) return { ok: true, cancelled: true };
    const { steps, masked, dropped } = macros.stepsFromRecording(rec.events, { startUrl: rec.startUrl });
    const draft = { name: '', description: '', steps, shortcut: '', site: '', masked, dropped: dropped.length };
    pendingDraft = draft;
    deps.openSettings?.('macros');
    deps.emitTo?.('macros:draft', draft);
    return { ok: true, steps: steps.length, masked };
  }

  // ---------- IPC ----------
  function register() {
    const { ipcMain } = deps;
    ipcMain.handle('macros:list', () => store.list());
    ipcMain.handle('macros:menu', () => store.list().map(summary));
    ipcMain.handle('macros:save', (_e, input) => { const r = store.save(input); if (r.ok) changed(); return { ...r, macros: store.list() }; });
    ipcMain.handle('macros:delete', (_e, id) => { const ok = store.remove(String(id)); if (ok) changed(); return { ok, macros: store.list() }; });
    ipcMain.handle('macros:shortcut-check', (_e, chord, exceptId) => {
      if (!chord) return { ok: true, chord: '' };
      const problem = macros.shortcutProblem(chord, { macros: store.list(), exceptId: exceptId || null, platform });
      return problem ? { ok: false, error: problem } : { ok: true, chord: macros.normalizeChord(chord, platform) };
    });
    ipcMain.handle('macros:validate', (_e, input) => {
      const r = macros.normalizeMacro(input, { strict: true, platform });
      return r.ok ? { ok: true, variables: macros.variablesOf(r.macro) } : { ok: false, error: r.error, stepIndex: r.stepIndex ?? null };
    });
    ipcMain.handle('macros:run', (_e, request = {}) => {
      const values = request.values && typeof request.values === 'object' ? request.values : {};
      const source = String(request.source || 'menu');
      if (request.macro && typeof request.macro === 'object') { // the editor's test run: the steps as they are now, not saved
        const r = macros.normalizeMacro({ ...request.macro, shortcut: '' }, { strict: true, platform });
        return r.ok ? runForUser(r.macro, { values, source }) : { ok: false, message: r.error };
      }
      return runForUser(String(request.id || request.name || ''), { values, source });
    });
    ipcMain.handle('macros:stop', (_e, runId) => { const r = runs.get(String(runId)); if (r) r.controller.abort(); return Boolean(r); });
    ipcMain.handle('macros:resume', (_e, runId) => { const r = runs.get(String(runId)); r?.resume?.(true); return Boolean(r); });
    ipcMain.handle('macros:edit', (_e, id) => { deps.openSettings?.('macros'); deps.emitTo?.('macros:edit', String(id)); return true; });
    ipcMain.handle('macros:record-start', () => startRecording());
    ipcMain.handle('macros:record-stop', (_e, opts) => stopRecording({ cancel: opts?.cancel === true }));
    ipcMain.handle('macros:take-draft', () => { const d = pendingDraft; pendingDraft = null; return d; });
    ipcMain.handle('macros:describe', async (_e, text) => {
      const sentence = String(text ?? '').trim().slice(0, 1000);
      if (!sentence) return { ok: false, error: 'Describe what the macro should do.' };
      try {
        const raw = await deps.complete({ system: DRAFT_SYSTEM, user: `Make a macro for: ${sentence}`, schema: DRAFT_SCHEMA });
        const r = draftFromModel(raw);
        if (!r.ok || !r.macro) return { ok: false, error: 'The model’s draft could not be used. Try again, or say it differently.' };
        const { id, createdAt, updatedAt, ...draft } = r.macro;
        draft.name = macros.uniqueName(store.list(), draft.name);
        return { ok: true, draft, dropped: r.dropped.length };
      } catch (err) {
        return { ok: false, error: String(err?.message || err).slice(0, 300) };
      }
    });
    ipcMain.handle('macros:export', async (_e, ids) => {
      const all = store.list();
      const chosen = Array.isArray(ids) && ids.length ? all.filter((m) => ids.includes(m.id)) : all;
      const { canceled, filePath } = await deps.dialog.showSaveDialog(deps.win(), { title: 'Export macros', defaultPath: path.join(deps.documentsDir?.() || '.', 'lumen-macros.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (canceled || !filePath) return { ok: false, canceled: true };
      await fs.promises.writeFile(filePath, macros.exportText(chosen), 'utf8');
      return { ok: true, count: chosen.length, filePath };
    });
    ipcMain.handle('macros:export-text', () => macros.exportText(store.list()));
    const review = (text) => {
      const r = macros.reviewImport(text, store.list(), { platform });
      pendingImport = r.ok ? { token: crypto.randomBytes(8).toString('hex'), candidates: r.candidates.map((c) => c.macro) } : null;
      return { ...r, token: pendingImport?.token || null };
    };
    ipcMain.handle('macros:import-pick', async () => {
      const { canceled, filePaths } = await deps.dialog.showOpenDialog(deps.win(), { title: 'Import macros', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (canceled || !filePaths?.[0]) return { ok: false, canceled: true };
      let stat;
      try { stat = await fs.promises.stat(filePaths[0]); } catch { return { ok: false, error: 'That file could not be read.', candidates: [], rejected: [] }; }
      if (stat.size > macros.MAX_IMPORT_BYTES) return { ok: false, error: `That file is larger than ${macros.MAX_IMPORT_BYTES / 1024} KB, too big to be a macros file. Nothing was imported.`, candidates: [], rejected: [] };
      return review(await fs.promises.readFile(filePaths[0], 'utf8'));
    });
    ipcMain.handle('macros:import-text', (_e, text) => review(text));
    ipcMain.handle('macros:import-commit', (_e, token, indexes) => {
      if (!pendingImport || pendingImport.token !== token) return { ok: false, error: 'Review the file again.' };
      const chosen = (Array.isArray(indexes) ? indexes : []).map((i) => pendingImport.candidates[i]).filter(Boolean);
      pendingImport = null;
      const added = store.addAll(chosen);
      if (added.length) changed();
      return { ok: true, added: added.length, macros: store.list() };
    });
  }

  // The "⋯" menu's Macros submenu.
  function menuTemplate({ t }) {
    const list = store.list();
    const items = list.slice(0, 15).map((m) => ({ label: m.name, ...(m.shortcut ? { sublabel: shortcutLabel(m.shortcut) } : {}), click: () => { runForUser(m, { source: 'menu' }).then((r) => { if (!r.ok && r.message) deps.send?.('macros:progress', { phase: 'failed', error: r.message, macro: m.name, macroId: m.id, final: true, index: 0, total: m.steps.length }); }).catch(() => {}); } }));
    return [
      ...(items.length ? items : [{ label: t('macros.menu.none'), enabled: false }]),
      { type: 'separator' },
      recording ? { label: t('macros.menu.stop'), click: () => { stopRecording().catch(() => {}); } } : { label: t('macros.menu.record'), click: () => { startRecording().catch(() => {}); } },
      { label: t('macros.menu.manage'), click: () => deps.openSettings?.('macros') },
    ];
  }
  const shortcutLabel = (chord) => require('./shortcuts-help').formatChord(chord, platform);

  // A key press that is a macro's shortcut: runs it. True when it was one.
  function handleKey(input) {
    const macro = macros.macroForInput(store.peek(), input, platform);
    if (!macro) return false;
    runForUser(macro, { source: 'shortcut' }).then((r) => { if (!r.ok && !r.asking && r.message) deps.send?.('macros:progress', { phase: 'failed', error: r.message, macro: macro.name, macroId: macro.id, final: true, index: 0, total: macro.steps.length }); }).catch(() => {});
    return true;
  }

  return { register, store, runForUser, runForAI, startRecording, stopRecording, menuTemplate, handleKey, summary, isRecording: () => Boolean(recording), runs, draftFromModel };
}

module.exports = { create, draftFromModel, DRAFT_SCHEMA, RECORD_WORLD };
