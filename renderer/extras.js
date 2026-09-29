// Sidebar additions kept out of app.js (merge-friendly):
//  - the Claude Code / Grok Build engines' placeholder,
//  - the "Using: <page>" chip above the composer (the current tab rides along with each message),
//  - the pending-approval badge on the toolbar button while the sidebar is closed,
//  - [usage] the plan meter under the page chip while a Claude Code model is picked.
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

  // ---------- page context chip ----------

  let include = true;
  let lastState = null;
  const chip = Object.assign(document.createElement('div'), { id: 'page-context', className: 'page-context', hidden: true });
  chip.setAttribute('role', 'status');
  const label = Object.assign(document.createElement('span'), { className: 'pc-label', textContent: window.t('context.using') });
  const icon = Object.assign(document.createElement('img'), { className: 'pc-icon', alt: '' });
  icon.onerror = () => { icon.hidden = true; };
  const title = Object.assign(document.createElement('span'), { className: 'pc-title' });
  const toggle = Object.assign(document.createElement('button'), { type: 'button', className: 'pc-toggle' });
  const siteToggle = Object.assign(document.createElement('button'), { type: 'button', className: 'pc-toggle pc-site', hidden: true }); // [ai controls]
  chip.append(label, icon, title, toggle, siteToggle);
  // First row inside the floating composer (it is absolutely positioned, so a sibling would sit under it).
  $('composer')?.prepend(chip);

  function renderChip(state = lastState) {
    lastState = state;
    const tab = state?.tabs?.find((t) => t.id === state.activeId);
    const web = Boolean(tab?.url) && /^https?:/i.test(tab.url);
    chip.hidden = !web;
    if (!web) return;
    const aiOff = siteState.url === tab.url && siteState.off;
    if (siteState.url !== tab.url || siteStale) { siteStale = false; refreshSite(tab.url); }
    chip.classList.toggle('ai-off', aiOff);
    siteToggle.hidden = siteState.url !== tab.url || !siteState.site;
    siteToggle.textContent = aiOff ? 'Turn on AI' : 'AI off here';
    siteToggle.title = aiOff ? `Let the AI read and act on ${siteState.site} again` : `Turn off AI on ${siteState.site}: the AI can't see or act on this site's tabs, and they aren't sent with messages`;
    siteToggle.setAttribute('aria-pressed', String(aiOff));
    toggle.hidden = aiOff;
    if (aiOff) {
      chip.classList.remove('excluded');
      label.textContent = 'AI is off on:';
      title.textContent = siteState.site;
      chip.title = `You turned off AI on ${siteState.site}. The AI can't see or act on its tabs.`;
      icon.hidden = true;
      return;
    }
    chip.classList.toggle('excluded', !include);
    label.textContent = include ? window.t('context.using') : window.t('context.notUsing');
    title.textContent = tab.title || tab.url;
    chip.title = include ? window.t('context.sent', { url: tab.url }) : window.t('context.notSent');
    icon.hidden = !tab.favicon;
    if (tab.favicon && icon.getAttribute('src') !== tab.favicon) icon.src = tab.favicon;
    toggle.textContent = include ? '×' : window.t('context.include');
    toggle.title = include ? window.t('context.stop') : window.t('context.send');
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-pressed', String(!include));
  }
  // [ai controls] Whether the tab's site has AI turned off (features/ai-sites.js answers: it knows
  // what counts as one site). Asked again on every tab update, so a change in Settings shows up.
  let siteState = { url: null, site: '', off: false };
  let siteStale = false;
  let asking = null;
  function refreshSite(url) {
    asking = url;
    extras.aiSiteState?.(url).then((state) => {
      if (asking !== url) return;
      asking = null;
      siteState = { url, site: state?.site || '', off: Boolean(state?.off) };
      renderChip();
    }).catch(() => { asking = null; });
  }
  siteToggle.addEventListener('click', async () => {
    if (!siteState.site) return;
    await extras.setAiSite?.(siteState.site, !siteState.off);
    siteStale = true;
    renderChip();
  });
  window.browser.onTabs?.(() => { siteStale = true; }); // re-ask after each change

  toggle.addEventListener('click', async () => {
    include = !include;
    renderChip();
    await extras.setPageContext?.(include);
  });
  window.browser.onTabs?.((state) => renderChip(state)); // follows tab switches, titles and navigation
  extras.getPageContext?.().then((on) => { include = on !== false; renderChip(); });

  // ---------- [usage] the usage bar ----------
  // One compact bar per CLI engine, from features/usage.js's barFor(): Claude Code shows its plan's
  // 5-hour limit ("Plan 29% · resets 8:09 PM · week 12% · Lumen ≈3"); Grok Build shows the tokens and
  // cost of today's sidebar turns, and the context window's fill when the CLI reports its size. The
  // bar hides when there is nothing real to show. Live during a Claude turn (rate_limit_event),
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
  chip.after(meter);
  meter.addEventListener('click', () => extras.openUsage?.());
  let usage = null;
  const ENGINE_NAMES = { claudecode: 'Claude Code', grokbuild: 'Grok Build' };
  const engineKey = () => String(select?.value || '').split(':')[0];
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
  const pts = (n) => (n < 1 ? '<1' : String(Math.round(n)));
  function renderMeter() {
    const key = engineKey();
    const bar = ENGINE_NAMES[key] ? usage?.bars?.[key] : null;
    meter.hidden = !bar;
    if (!bar) return;
    const engine = ENGINE_NAMES[key];
    const text = [];
    const title = [];
    const percent = bar.percent == null ? null : Math.round(bar.percent);
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
    } else {
      if (percent != null) {
        text.push(window.t('usage.context', { percent }));
        title.push(window.t('usage.context.title', { percent, used: compact(bar.contextTokens), total: compact(bar.contextWindow) }));
      }
      if (bar.tokens) text.push(window.t('usage.tokens', { tokens: compact(bar.tokens) }) + (bar.costUSD > 0 ? ` · ~$${bar.costUSD < 0.01 ? bar.costUSD.toFixed(4) : bar.costUSD.toFixed(2)}` : ''));
      title.push(window.t('usage.tokens.title', { engine }));
    }
    meterBar.hidden = percent == null;
    if (percent != null) {
      meterFill.style.width = `${percent}%`;
      meterBar.setAttribute('aria-valuenow', String(percent));
      meterBar.setAttribute('aria-valuetext', text[0]);
    }
    meterBar.setAttribute('aria-label', window.t('usage.label', { engine }));
    meter.classList.toggle('high', percent != null && percent >= 80);
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

  // ---------- the pending-approval badge ----------

  const pending = new Set();
  const button = $('toggle-sidebar');
  function syncBadge() {
    const show = pending.size > 0 && document.body.classList.contains('sidebar-hidden');
    button?.classList.toggle('approval-pending', show);
    if (show) button?.setAttribute('aria-description', window.t('approval.pending'));
    else button?.removeAttribute('aria-description');
  }
  new MutationObserver(syncBadge).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  const showBase = window.showApproval;
  window.showApproval = function showApproval(approvalId, host, options) {
    pending.add(approvalId);
    const result = showBase(approvalId, host, options);
    syncBadge();
    return result;
  };
  const resolveBase = window.resolveApproval;
  window.resolveApproval = function resolveApproval(approvalId, ok) {
    const result = resolveBase(approvalId, ok);
    pending.delete(approvalId);
    syncBadge();
    return result;
  };

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
