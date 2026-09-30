// Sidebar additions kept out of app.js (merge-friendly):
//  - the "Using: <page>" chip above the composer (the current tab rides along with each message),
//  - the pending-approval badge on the toolbar button while the sidebar is closed.
// (The engine placeholder, the usage bar and Undo are shared with the chat page: chat-extras.js.)
(() => {
  const $ = (id) => document.getElementById(id);
  const extras = window.lumenExtras || {};

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
    siteToggle.textContent = aiOff ? window.t('context.aiOn') : window.t('context.aiOff');
    siteToggle.title = aiOff ? window.t('context.aiOn.title', { site: siteState.site }) : window.t('context.aiOff.title', { site: siteState.site });
    siteToggle.setAttribute('aria-pressed', String(aiOff));
    toggle.hidden = aiOff;
    if (aiOff) {
      chip.classList.remove('excluded');
      label.textContent = window.t('context.offOn');
      title.textContent = siteState.site;
      chip.title = window.t('context.offOn.title', { site: siteState.site });
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
})();
