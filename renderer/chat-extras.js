// Shared by the sidebar and the full-page chat (loaded after chat-core.js on both):
//  - the Claude Code / Grok Build engines' placeholder,
//  - [usage] the plan meter under the composer's first row while a Claude Code model is picked,
//  - [ai controls] "Undo tab changes" under a reply.
// What only the sidebar has (the "Using: <page>" chip, the toolbar's approval badge) stays in extras.js.
(() => {
  const $ = (id) => document.getElementById(id);
  const extras = window.lumenExtras || {};

  // ---------- local agent engines: the placeholder ----------

  const select = $('model');
  const ENGINE_PLACEHOLDERS = { 'claudecode:': window.t('composer.ask', { name: 'Claude' }), 'grokbuild:': window.t('composer.ask', { name: 'Grok' }) };
  function syncEngine() {
    const value = String(select?.value || '');
    const prefix = Object.keys(ENGINE_PLACEHOLDERS).find((p) => value.startsWith(p));
    const placeholder = prefix && ENGINE_PLACEHOLDERS[prefix];
    if (placeholder && $('prompt').placeholder !== placeholder) $('prompt').placeholder = placeholder;
  }
  new MutationObserver(syncEngine).observe($('prompt'), { attributes: true, attributeFilter: ['placeholder'] }); // app.js sets it after the model switch
  select?.addEventListener('change', () => setTimeout(syncEngine));
  if (select) new MutationObserver(() => setTimeout(syncEngine)).observe(select, { childList: true });
  const loadBase = window.loadModels;
  window.loadModels = async (...args) => { await loadBase(...args); syncEngine(); };

  // ---------- [usage] the usage bar ----------
  // One compact bar per CLI engine, from features/usage.js's barFor(): Claude Code shows its plan's
  // 5-hour limit ("Plan 29% · resets 8:09 PM · week 12% · Lumen ≈3"); Grok Build, which
  // publishes no plan limits, shows the chat's context-window fill with today's tokens and cost, a
  // progress bar toward the budget the user set, or "limit reached" with its reset time; never a
  // plan percentage. With nothing real yet it shows a hint instead of a bar. Live during a Claude turn (rate_limit_event),
  // refreshed after each one; a click opens Settings → Usage.
  const meter = Object.assign(document.createElement('button'), { type: 'button', id: 'usage-meter', className: 'usage-meter', hidden: true });
  const meterBar = Object.assign(document.createElement('span'), { className: 'um-bar' });
  const meterFill = document.createElement('i');
  meterBar.append(meterFill);
  meterBar.setAttribute('role', 'progressbar');
  meterBar.setAttribute('aria-valuemin', '0');
  meterBar.setAttribute('aria-valuemax', '100');
  const meterText = Object.assign(document.createElement('span'), { className: 'um-text' });
  meter.append(meterBar, meterText);
  if ($('page-context')) $('page-context').after(meter); // under the sidebar's page chip
  else $('composer')?.prepend(meter); // the chat page has no chip
  meter.addEventListener('click', () => extras.openUsage?.());
  let usage = null;
  const ENGINE_NAMES = { claudecode: 'Claude Code', grokbuild: 'Grok Build' };
  const engineKey = () => String(select?.value || '').split(':')[0];
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
  const pts = (n) => (n < 1 ? '<1' : String(Math.round(n)));
  const money = (n) => (n <= 0 ? '$0' : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`);
  // A time of day when it is today, else with the weekday too ("Mon 12:00 AM").
  const when = (ms) => (new Date(ms).toDateString() === new Date().toDateString() ? clock(ms) : new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }));
  let limitTimer = null;
  // What Grok's bar says (features/usage.js barFor, kinds limit | budget | context). Grok publishes
  // no plan limits, so nothing here is "plan remaining": the title says whose use it is.
  function grokParts(bar, text, title) {
    let head = null;
    if (bar.kind === 'limit') {
      head = bar.resetsAt ? window.t('usage.grok.limit', { time: when(bar.resetsAt) }) : window.t('usage.grok.limit.unknown');
      text.push(head);
      title.push(window.t('usage.grok.limit.title'));
      if (bar.message) title.push(bar.message);
    } else if (bar.kind === 'budget') {
      const fmt = bar.unit === 'tokens' ? (n) => window.t('usage.tokens', { tokens: compact(n) }) : money;
      const period = window.t(bar.period === 'weekly' ? 'usage.period.weekly' : 'usage.period.daily');
      head = window.t('usage.grok.budget', { percent: Math.round(bar.percent) });
      text.push(head, window.t('usage.grok.budget.of', { used: fmt(bar.used), limit: fmt(bar.limit), period }), window.t('usage.resets', { time: when(bar.resetsAt) }));
      title.push(window.t('usage.grok.budget.title', { percent: Math.round(bar.percent), used: fmt(bar.used), limit: fmt(bar.limit), period }));
    } else {
      if (bar.percent != null) {
        head = window.t('usage.grok.context', { percent: Math.round(bar.percent) });
        text.push(head);
        title.push(window.t('usage.context.title', { percent: Math.round(bar.percent), used: compact(bar.contextTokens), total: compact(bar.contextWindow) }));
        if (bar.compactPercent) title.push(window.t('usage.grok.compact.title', { percent: bar.compactPercent }));
      }
      if (bar.tokens) text.push(window.t('usage.tokens', { tokens: compact(bar.tokens) }));
      if (bar.costUSD > 0) text.push(window.t('usage.grok.cost', { cost: money(bar.costUSD) }));
    }
    const w = bar.windows;
    if (w && w.d7?.turns) {
      title.push(window.t('usage.grok.windows.title', { t5: compact(w.h5.tokens), c5: money(w.h5.costUSD), t7: compact(w.d7.tokens), c7: money(w.d7.costUSD) }));
    }
    title.push(window.t('usage.grok.noplan.title'));
    return head;
  }
  function renderMeter() {
    const key = engineKey();
    const bar = ENGINE_NAMES[key] ? usage?.bars?.[key] : null;
    clearTimeout(limitTimer);
    // Grok Build, nothing real yet: the bar stays hidden, and a hint says how to get one.
    const hint = !bar && key === 'grokbuild' && Boolean(usage);
    meter.hidden = !bar && !hint;
    meter.classList.toggle('hint', hint);
    if (hint) {
      meterBar.hidden = true;
      meter.classList.remove('high', 'warn');
      delete meter.dataset.kind;
      meterText.textContent = window.t('usage.grok.hint');
      meter.title = `${window.t('usage.grok.noplan.title')} ${window.t('usage.more')}`;
      return;
    }
    if (!bar) return;
    const engine = ENGINE_NAMES[key];
    const text = [];
    const title = [];
    const percent = bar.percent == null ? null : Math.round(bar.percent);
    let head = null;
    if (bar.kind === 'plan') {
      const resets = bar.resetsAt ? clock(bar.resetsAt) : bar.resetsText;
      text.push(window.t('usage.plan', { percent }));
      if (resets) text.push(window.t('usage.resets', { time: resets }));
      if (bar.weekly) text.push(window.t('usage.week', { percent: Math.round(bar.weekly.percent) }));
      if (bar.lumenPoints != null) text.push(window.t('usage.lumen', { points: pts(bar.lumenPoints) }));
      title.push(window.t('usage.plan.title', { percent }));
      if (resets) title.push(window.t('usage.resets.title', { time: resets }));
      if (bar.weekly) title.push(window.t('usage.week.title', { percent: Math.round(bar.weekly.percent) }));
      if (bar.lumenPoints != null) title.push(window.t('usage.share.title', { points: pts(bar.lumenPoints) }));
      head = text[0];
    } else if (key === 'grokbuild') {
      head = grokParts(bar, text, title);
      if (bar.kind === 'limit' && bar.resetsAt) limitTimer = setTimeout(() => refreshUsage(false), Math.min(2 ** 31 - 1, Math.max(1000, bar.resetsAt - Date.now() + 1000)));
    } else {
      if (percent != null) {
        text.push(window.t('usage.context', { percent }));
        title.push(window.t('usage.context.title', { percent, used: compact(bar.contextTokens), total: compact(bar.contextWindow) }));
        head = text[0];
      }
      if (bar.tokens) text.push(window.t('usage.tokens', { tokens: compact(bar.tokens) }) + (bar.costUSD > 0 ? ` · ~$${bar.costUSD < 0.01 ? bar.costUSD.toFixed(4) : bar.costUSD.toFixed(2)}` : ''));
      title.push(window.t('usage.tokens.title', { engine }));
    }
    meterBar.hidden = percent == null;
    if (percent != null) {
      meterFill.style.width = `${percent}%`;
      meterBar.setAttribute('aria-valuenow', String(percent));
      meterBar.setAttribute('aria-valuetext', head || text[0]);
    }
    meterBar.setAttribute('aria-label', window.t('usage.label', { engine }));
    const level = bar.level || (percent != null && percent >= 80 ? 'high' : 'ok');
    meter.classList.toggle('high', level === 'high');
    meter.classList.toggle('warn', level === 'warn');
    meter.dataset.kind = bar.kind;
    meterText.textContent = text.join(' · ');
    meter.title = `${title.join(' ')} ${window.t('usage.more')}`;
  }
  async function refreshUsage(force) {
    if (!ENGINE_NAMES[engineKey()] || !extras.usage) { renderMeter(); return; }
    usage = await extras.usage(force).catch(() => usage);
    renderMeter();
  }
  select?.addEventListener('change', () => setTimeout(() => refreshUsage(false)));
  window.assistant?.onEvent?.((event) => {
    const w = event.type === 'rate_limit' && event.info?.unifiedWindows?.five_hour;
    if (w && usage?.bars?.claudecode) {
      usage.bars.claudecode = { ...usage.bars.claudecode, percent: Math.max(0, Math.min(100, Number(w.utilization) * 100)), resetsAt: Number(w.resetsAt) * 1000 };
      renderMeter();
    } else if (event.type === 'done') setTimeout(() => refreshUsage(false), 300);
  });
  setTimeout(() => refreshUsage(false), 1500); // after the model list has loaded

  // ---------- [ai controls] "Undo" under a reply that changed your tabs ----------
  // `undo` ({ id, undoable, lasting }) comes with the run's 'done' event (agent.js undoSummary):
  // the tabs it opened, closed, moved to other pages or regrouped can be put back; what it did on
  // sites (lasting: clicks, typing, forms) can't, and the button says so.
  window.showRunUndo = function showRunUndo(append, undo) {
    if (!undo?.undoable) return;
    const box = append(Object.assign(document.createElement('div'), { className: 'run-undo' }));
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Undo tab changes' });
    const lasting = undo.lasting?.length ? `Can't be undone here: ${undo.lasting.join('; ')}.` : '';
    button.title = `Close the tabs this reply opened, reopen the ones it closed, and take its tabs back to where they were.${lasting ? `
${lasting}` : ''}`;
    box.append(button);
    button.addEventListener('click', async () => {
      button.disabled = true;
      let result;
      try { result = await window.assistant.undoRun(undo.id); } catch (err) { result = { ok: false, message: String(err?.message || err) }; }
      button.remove();
      const lines = result?.ok ? [...result.done, ...result.skipped] : [result?.message || 'Nothing was undone.'];
      if (result?.ok && !lines.length) lines.push('Nothing was left to undo.');
      if (result?.ok && result.lasting?.length) lines.push(`Can't be undone here: ${result.lasting.join('; ')}.`);
      const list = Object.assign(document.createElement('ul'), { className: 'run-undo-result' });
      for (const line of lines) list.append(Object.assign(document.createElement('li'), { textContent: line }));
      box.append(list);
    });
  };
})();
