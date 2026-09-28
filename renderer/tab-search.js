// Tab search (Ctrl+Shift+A, or the button at the end of the tab strip): open tabs and recently
// closed ones, filtered as you type (tab-search-match.js); ↑/↓ pick, Enter switches or reopens.
// Also the speaker button on a tab playing sound, which mutes it (app.js's updateTabEl calls
// updateTabAudio). main.js side: features/tab-tools.js.

const SPEAKER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6h2.5L9 3v10L5.5 10H3z"/><path class="wave" d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/><path class="cross" d="M11 6l4 4M15 6l-4 4"/></svg>';

// ---- speaker button on a tab
function updateTabAudio(el, tab) {
  let button = el.querySelector('.tab-audio');
  const show = Boolean(tab.audible || tab.muted);
  if (!show) {
    button?.remove();
    return;
  }
  if (!button) {
    button = Object.assign(document.createElement('button'), { className: 'tab-audio', type: 'button', innerHTML: SPEAKER });
    button.addEventListener('pointerdown', (e) => e.stopPropagation()); // not a tab drag or ✕ press
    button.onclick = (e) => { e.stopPropagation(); window.browser.toggleMute(Number(el.dataset.id)); };
    el.querySelector('.tab-title').before(button);
  }
  button.classList.toggle('muted', Boolean(tab.muted));
  const label = tab.muted ? 'Unmute tab' : 'Mute tab';
  button.title = label;
  button.setAttribute('aria-label', `${label}: ${tab.title}`);
}

// ---- search popup
const tabSearch = (() => {
  let state = { tabs: [], activeId: null };
  let closed = [];
  let results = [];
  let selected = 0;
  let panel = null;
  let input = null;
  let list = null;

  const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

  function build() {
    panel = Object.assign(document.createElement('div'), { id: 'tab-search-panel', className: 'tab-search-panel', hidden: true });
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Search tabs');
    input = Object.assign(document.createElement('input'), { id: 'tab-search-input', type: 'search', placeholder: 'Search tabs', autocomplete: 'off', spellcheck: false });
    input.setAttribute('aria-controls', 'tab-search-results');
    list = Object.assign(document.createElement('ul'), { id: 'tab-search-results', className: 'tab-search-results' });
    list.setAttribute('role', 'listbox');
    panel.append(input, list);
    document.body.append(panel);
    input.addEventListener('input', () => { selected = 0; render(); });
    input.addEventListener('keydown', onKey);
    list.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the focus in the box
    document.addEventListener('pointerdown', (e) => { if (isOpen() && !panel.contains(e.target) && !e.target.closest('#tab-search')) close(); }, true);
    window.addEventListener('blur', () => { if (isOpen()) close(); });
  }

  const isOpen = () => Boolean(panel && !panel.hidden);

  function items() {
    const open = state.tabs.map((t) => ({ kind: 'open', id: t.id, title: t.title, url: t.url, favicon: t.favicon, audible: t.audible, active: t.id === state.activeId }));
    const gone = closed.map((c) => ({ kind: 'closed', index: c.index, title: c.title, url: c.url }));
    const q = input.value;
    return [...tabSearchMatch.rank(q, open), ...tabSearchMatch.rank(q, gone).slice(0, 10)];
  }

  function row(item, i) {
    const li = document.createElement('li');
    li.className = 'tab-search-item' + (i === selected ? ' selected' : '') + (item.active ? ' current' : '');
    li.id = `tab-search-item-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === selected));
    li.dataset.kind = item.kind;
    let icon;
    if (item.favicon) {
      icon = Object.assign(document.createElement('img'), { className: 'tab-search-icon', src: item.favicon, alt: '' });
      icon.onerror = () => icon.replaceWith(Object.assign(document.createElement('span'), { className: 'tab-search-icon blank' }));
    } else icon = Object.assign(document.createElement('span'), { className: 'tab-search-icon blank' });
    const text = Object.assign(document.createElement('span'), { className: 'tab-search-text' });
    text.append(
      Object.assign(document.createElement('span'), { className: 'tab-search-title', textContent: item.title || item.url || 'New Tab' }),
      Object.assign(document.createElement('span'), { className: 'tab-search-host', textContent: hostOf(item.url) }),
    );
    li.append(icon, text);
    if (item.audible) li.append(Object.assign(document.createElement('span'), { className: 'tab-search-audio', innerHTML: SPEAKER, title: 'Playing audio' }));
    li.onmousemove = () => { if (selected !== i) { selected = i; render(); } };
    li.onclick = () => activate(item);
    return li;
  }

  function render() {
    if (!isOpen()) return;
    results = items();
    selected = Math.min(selected, Math.max(0, results.length - 1));
    list.replaceChildren();
    let section = null;
    results.forEach((item, i) => {
      if (item.kind !== section) {
        section = item.kind;
        const header = Object.assign(document.createElement('li'), { className: 'tab-search-section', textContent: section === 'open' ? 'Open tabs' : 'Recently closed' });
        header.setAttribute('role', 'presentation');
        list.append(header);
      }
      list.append(row(item, i));
    });
    if (!results.length) list.append(Object.assign(document.createElement('li'), { className: 'tab-search-empty', textContent: 'No matching tabs' }));
    const current = document.getElementById(`tab-search-item-${selected}`);
    if (current) {
      input.setAttribute('aria-activedescendant', current.id);
      current.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  function onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selected]) activate(results[selected]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function activate(item) {
    close();
    if (item.kind === 'open') window.browser.switchTab(item.id);
    else window.browser.reopenClosed(item.index, item.url);
  }

  async function open() {
    if (!panel) build();
    if (isOpen()) { input.select(); return; }
    closed = await window.browser.closedTabs().catch(() => []);
    panel.hidden = false;
    document.getElementById('tab-search')?.setAttribute('aria-expanded', 'true');
    freezePage(); // app.js: the page shows as a still image so the popup can sit over it
    input.value = '';
    selected = 0;
    render();
    input.focus();
  }

  function close() {
    if (!isOpen()) return;
    panel.hidden = true;
    document.getElementById('tab-search')?.setAttribute('aria-expanded', 'false');
    thawPage();
  }

  window.browser.onTabs((next) => { state = next; render(); });
  window.browser.onOpenTabSearch(open);
  document.getElementById('tab-search')?.addEventListener('click', () => (isOpen() ? close() : open()));
  return { open, close, isOpen };
})();
