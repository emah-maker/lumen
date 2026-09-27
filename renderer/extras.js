// Sidebar additions kept out of app.js (merge-friendly):
//  - the Claude Code engine's note under the model picker,
//  - the "Using: <page>" chip above the composer (the current tab rides along with each message),
//  - the pending-approval badge on the toolbar button while the sidebar is closed.
(() => {
  const $ = (id) => document.getElementById(id);
  const extras = window.lumenExtras || {};

  // ---------- Claude Code engine: the note and the placeholder ----------

  const select = $('model');
  const note = Object.assign(document.createElement('p'), {
    id: 'cc-note',
    className: 'cc-note',
    hidden: true,
    textContent: "Uses your Claude Code login. For personal use; apps offered to others need Anthropic's approval to use claude.ai logins.",
  });
  document.querySelector('.sidebar-head')?.after(note);
  function syncEngine() {
    const on = String(select?.value || '').startsWith('claudecode:');
    note.hidden = !on;
    if (on && $('prompt').placeholder !== 'Ask Claude…') $('prompt').placeholder = 'Ask Claude…';
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
  chip.append(label, icon, title, toggle);
  // First row inside the floating composer (it is absolutely positioned, so a sibling would sit under it).
  $('composer')?.prepend(chip);

  function renderChip(state = lastState) {
    lastState = state;
    const tab = state?.tabs?.find((t) => t.id === state.activeId);
    const web = Boolean(tab?.url) && /^https?:/i.test(tab.url);
    chip.hidden = !web;
    if (!web) return;
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
  window.showApproval = function showApproval(approvalId, host) {
    pending.add(approvalId);
    const result = showBase(approvalId, host);
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
