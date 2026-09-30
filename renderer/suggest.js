const SEARCH = '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>';
const CLOCK = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>';

const list = document.getElementById('list');
let lastShown = 0;

window.suggest.onItems(({ items, selected, listId }) => {
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
    li.innerHTML = item.kind === 'search' ? SEARCH : CLOCK;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.title;
    li.append(title);
    if (item.detail) {
      const url = document.createElement('span');
      url.className = 'url';
      url.textContent = `— ${item.detail}`;
      li.append(url);
    }
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
