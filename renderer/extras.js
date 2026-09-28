// Sidebar additions kept out of app.js (merge-friendly):
//  - the Claude Code / Grok Build engines' placeholder,
//  - the "Using: <page>" chip above the composer (the current tab rides along with each message),
//  - the pending-approval badge on the toolbar button while the sidebar is closed.
(() => {
  const $ = (id) => document.getElementById(id);
  const extras = window.lumenExtras || {};

  // ---------- local agent engines: the placeholder ----------

  const select = $('model');
  const ENGINE_PLACEHOLDERS = { 'claudecode:': 'Ask Claude…', 'grokbuild:': 'Ask Grok…' };
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
  const label = Object.assign(document.createElement('span'), { className: 'pc-label', textContent: 'Using:' });
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
    label.textContent = include ? 'Using:' : 'Not using:';
    title.textContent = tab.title || tab.url;
    chip.title = include ? `The AI sees this tab's title, address and text with each message.\n${tab.url}` : 'This tab is not sent with your messages.';
    icon.hidden = !tab.favicon;
    if (tab.favicon && icon.getAttribute('src') !== tab.favicon) icon.src = tab.favicon;
    toggle.textContent = include ? '×' : 'Include';
    toggle.title = include ? 'Stop sending the page with messages' : 'Send the page with messages';
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

  // ---------- the pending-approval badge ----------

  const pending = new Set();
  const button = $('toggle-sidebar');
  function syncBadge() {
    const show = pending.size > 0 && document.body.classList.contains('sidebar-hidden');
    button?.classList.toggle('approval-pending', show);
    if (show) button?.setAttribute('aria-description', 'An action is waiting for your approval');
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
