const SEARCH = '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>';
const GLOBE = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 1.8 2.8 3.8 2.8 6S10 12.2 8 14M8 2C6 3.8 5.2 5.8 5.2 8S6 12.2 8 14"/></svg>';
const TAB = '<svg viewBox="0 0 16 16"><rect x="2" y="3.5" width="12" height="9" rx="1.8"/><path d="M2 6.5h12M5.5 3.5v3"/></svg>';
const CLOCK = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>';

const list = document.getElementById('list');
let lastShown = 0;

// Text with the typed words in bold (the first match, case-insensitive).
function fill(node, text, query) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) { node.textContent = text; return; }
  const bold = document.createElement('b');
  bold.textContent = text.slice(at, at + query.length);
  node.append(text.slice(0, at), bold, text.slice(at + query.length));
}
const ICONS = { search: SEARCH, site: GLOBE, tab: TAB };

window.suggest.onItems(({ items, selected, listId, query }) => {
  // Animate when the list opens (first use, after the view was hidden, or after a long pause), not per keystroke.
  const opening = lastShown === 0 || performance.now() - lastShown > 1500;
  lastShown = performance.now();
  list.replaceChildren();
  list.classList.toggle('entering', opening);
  items.forEach((item, index) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(index === selected));
    if (index === selected) li.className = 'selected';
    li.innerHTML = ICONS[item.kind] || CLOCK;
    li.setAttribute('aria-label', [item.badge, item.title, item.detail].filter(Boolean).join(', '));
    const bold = item.kind === 'search' ? '' : query; // (the search row repeats what was typed: nothing to pick out)
    const title = document.createElement('span');
    title.className = 'title';
    fill(title, item.title, bold);
    li.append(title);
    if (item.detail) {
      const url = document.createElement('span');
      url.className = 'url';
      url.append('— ');
      fill(url, item.detail, bold);
      li.append(url);
    }
    if (item.badge) li.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: item.badge }));
    // mousedown, not click: the address bar loses focus on mousedown and hides this list.
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      window.suggest.pick(index, listId); // listId: the address bar only acts on a pick from the list it last showed
    });
    li.style.animationDelay = `${Math.min(index, 5) * 22}ms`;
    list.append(li);
  });
  // A short window scrolls the list (suggest.html): keep the row the arrow keys picked in view.
  list.querySelector('li.selected')?.scrollIntoView({ block: 'nearest' });
});

document.addEventListener('visibilitychange', () => { if (document.hidden) lastShown = 0; });
