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
  const ENGINE_PLACEHOLDERS = { 'claudecode:': window.t('composer.ask', { name: 'Claude' }), 'grokbuild:': window.t('composer.ask', { name: 'Grok' }), 'antigravity:': window.t('composer.ask', { name: 'Antigravity' }), 'codex:': window.t('composer.ask', { name: 'Codex' }) };
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
  // Another chat is open (New chat, one from the chat list, or a new topic starting its own chat):
  // Grok's context bar is that chat's, empty for a new one. Main has switched chats by then.
  $('new-chat')?.addEventListener('click', () => setTimeout(() => refreshUsage(false), 50));
  window.chatUsageMeter = { refresh: () => refreshUsage(false) };
  window.assistant?.onEvent?.((event) => {
    const w = event.type === 'rate_limit' && event.info?.unifiedWindows?.five_hour;
    if (w && usage?.bars?.claudecode) {
      usage.bars.claudecode = { ...usage.bars.claudecode, percent: Math.max(0, Math.min(100, Number(w.utilization) * 100)), resetsAt: Number(w.resetsAt) * 1000 };
      renderMeter();
    } else if (event.type === 'done') setTimeout(() => refreshUsage(false), 300);
  });
  setTimeout(() => refreshUsage(false), 1500); // after the model list has loaded

  // ---------- [context] how full the open chat's context window is ----------
  // A ring left of Send, for every AI (features/chat-usage.js contextView: the last request's whole input against
  // the model's window, kept per chat and saved with it). Its tooltip has the numbers; a click runs /context. Main
  // pushes it after each request (chats:context); it is read again when another chat opens.
  const chatsApi = window.assistant?.chats;
  const SVG = 'http://www.w3.org/2000/svg';
  const ring = Object.assign(document.createElement('button'), { type: 'button', id: 'context-meter', className: 'context-meter', hidden: true });
  const ringSvg = document.createElementNS(SVG, 'svg');
  ringSvg.setAttribute('viewBox', '0 0 20 20');
  ringSvg.setAttribute('aria-hidden', 'true');
  const circle = (cls) => { const c = document.createElementNS(SVG, 'circle'); c.setAttribute('class', cls); c.setAttribute('cx', '10'); c.setAttribute('cy', '10'); c.setAttribute('r', '7.5'); c.setAttribute('pathLength', '100'); return c; };
  const ringFill = circle('cm-fill');
  ringSvg.append(circle('cm-track'), ringFill);
  ring.append(ringSvg);
  ($('send-bg') || $('send'))?.before(ring);
  function renderContext(view) {
    const show = Boolean(view && view.window > 0 && view.tokens > 0);
    ring.hidden = !show;
    if (!show) return;
    const percent = Math.round(view.percent);
    ringFill.setAttribute('stroke-dasharray', `${Math.max(view.percent, 1.5)} 100`);
    ring.classList.toggle('warn', percent >= 75 && percent < 90);
    ring.classList.toggle('high', percent >= 90);
    const vars = { percent, used: compact(view.tokens), total: compact(view.window) };
    const label = window.t(view.estimated ? 'context.label.estimated' : 'context.label', vars);
    ring.setAttribute('aria-label', label);
    ring.title = `${window.t(view.estimated ? 'context.title.estimated' : 'context.title', vars)} ${window.t(percent >= 75 ? 'context.compact' : 'context.more')}`;
  }
  async function refreshContext() {
    if (!chatsApi?.list) return;
    try { renderContext((await chatsApi.list())?.currentContext || null); } catch { /* the chat list is busy: the next push or reply redraws it */ }
  }
  chatsApi?.onContext?.(renderContext);
  ring.addEventListener('click', () => window.ask?.('/context'));
  $('new-chat')?.addEventListener('click', () => { renderContext(null); setTimeout(refreshContext, 50); });
  window.assistant?.onEvent?.((event) => { if (event.type === 'done') setTimeout(refreshContext, 300); });
  // Another chat is shown (opened from the list, the other view switched, a tab with its own chat): chats.js and
  // chat-page.js say so through chatList.refreshUsage and chatUsageMeter.refresh.
  if (window.chatList?.refreshUsage) {
    const base = window.chatList.refreshUsage;
    window.chatList.refreshUsage = (...args) => { const out = base(...args); refreshContext(); return out; };
  }
  window.chatUsageMeter.refresh = () => { refreshUsage(false); refreshContext(); };
  setTimeout(refreshContext, 1500);

  // ---------- [ai controls] "Undo" under a reply that changed your tabs ----------
  // `undo` ({ id, undoable, lasting }) comes with the run's 'done' event (agent.js undoSummary):
  // the tabs it opened, closed, moved to other pages or regrouped can be put back; what it did on
  // sites (lasting: clicks, typing, forms) can't, and the button says so.
  // ---------- [ai manners] "Close N tabs the AI opened" under a reply (main.js aiTabsAfterRun / aiTabsClose) ----------
  // `info` ({ n, mode: offer | ask }) comes with the run's 'done' event; with Settings > "Close tabs the AI opened" on Always, main
  // closes them itself and sends 'ai_tabs_closed' ({ n, token }): the row then says so and offers Undo. Never closes a tab you
  // used, a pinned tab or the one a chat lives in (main skips those: the count is what can really close).
  function aiTabsRow(append) {
    return append(Object.assign(document.createElement('div'), { className: 'run-undo ai-tabs', role: 'status' }));
  }
  const plural = (base, n, en) => { const k = `${base}.${n === 1 ? 'one' : 'other'}`; const s = window.t ? window.t(k, { count: n }) : k; return s && s !== k ? s : en.replace('{count}', n); };
  function undoRow(box, closed, token, kept = 0) {
    box.replaceChildren();
    box.append(Object.assign(document.createElement('span'), { className: 'ai-tabs-text', textContent: plural('chat.aiTabs.closed', closed, closed === 1 ? 'Closed {count} tab the AI opened.' : 'Closed {count} tabs the AI opened.') }), ' ');
    const undo = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: window.t?.('chat.aiTabs.undo') || 'Undo' });
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      const result = await window.assistant.undoCloseAiTabs(token).catch(() => null);
      box.replaceChildren(Object.assign(document.createElement('span'), { className: 'ai-tabs-text', textContent: result?.reopened ? plural('chat.aiTabs.reopened', result.reopened, 'Reopened {count} tabs.') : (window.t?.('chat.aiTabs.nothingReopened') || 'Nothing to reopen.') })); // (a second Undo of the same close finds nothing)
    });
    box.append(undo);
    if (kept > 0) box.append(' ', Object.assign(document.createElement('span'), { className: 'ai-tabs-text', textContent: plural('chat.aiTabs.kept', kept, kept === 1 ? '{count} stayed open: it holds text you typed, or asks before closing.' : '{count} stayed open: they hold text you typed, or ask before closing.') }));
    box.setAttribute('role', 'status');
  }
  window.showAiTabs = function showAiTabs(append, info, runId) {
    if (!info?.n || !window.assistant?.closeAiTabs) return;
    const box = aiTabsRow(append);
    const n = info.n;
    const text = Object.assign(document.createElement('span'), { className: 'ai-tabs-text' });
    if (info.mode === 'ask') text.textContent = plural('chat.aiTabs.ask', n, n === 1 ? 'The AI opened {count} tab. Close it?' : 'The AI opened {count} tabs. Close them?');
    const close = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: plural('chat.aiTabs.close', n, n === 1 ? 'Close {count} tab the AI opened' : 'Close {count} tabs the AI opened') });
    close.addEventListener('click', async () => {
      close.disabled = true;
      const result = await window.assistant.closeAiTabs({ runId }).catch(() => null);
      if (!result?.closed) {
        const keptText = result?.kept > 0 ? plural('chat.aiTabs.kept', result.kept, result.kept === 1 ? '{count} stayed open: it holds text you typed, or asks before closing.' : '{count} stayed open: they hold text you typed, or ask before closing.') : '';
        box.replaceChildren(Object.assign(document.createElement('span'), { className: 'ai-tabs-text', textContent: keptText || window.t?.('chat.aiTabs.none') || 'Nothing to close.' }));
        return;
      }
      undoRow(box, result.closed, result.token, result.kept);
    });
    box.append(...(info.mode === 'ask' ? [text, ' ', close] : [close]));
    if (info.mode === 'ask') {
      const keep = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: window.t?.('chat.aiTabs.keep') || 'Keep' });
      keep.addEventListener('click', () => box.remove());
      box.append(' ', keep);
    }
  };
  window.showAiTabsClosed = function showAiTabsClosed(append, event) {
    if (!event?.n || !event.token) return;
    undoRow(aiTabsRow(append), event.n, event.token, event.kept);
  };

  window.showRunUndo = function showRunUndo(append, undo) {
    if (!undo?.undoable) return;
    const box = append(Object.assign(document.createElement('div'), { className: 'run-undo' }));
    const tr = (k, en, v) => { const s = window.t ? window.t(k, v) : k; return s && s !== k ? s : en.replace(/\{(\w+)\}/g, (_, x) => v?.[x] ?? ''); };
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: tr('undo.button', 'Undo tab changes') });
    const lasting = undo.lasting?.length ? tr('undo.lasting', 'Can’t be undone here: {what}.', { what: undo.lasting.join('; ') }) : '';
    button.title = `${tr('undo.title', 'Close the tabs this reply opened, reopen the ones it closed, and take its tabs back to where they were.')}${lasting ? `\n${lasting}` : ''}`;
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
