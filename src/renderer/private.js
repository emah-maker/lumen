// The private window's UI: tab strip, back/forward/reload and the address box. State comes from
// features/private-window.js; this page only draws it and sends clicks back.
const api = window.privateUi;
const tabsEl = document.getElementById('tabs');
const address = document.getElementById('address');
let editing = false;

// Tabs are kept and updated in place, never rebuilt: a click needs its button to survive from press to
// release, and pressing a tab (which switches to it) or a page loading re-renders the strip. Rebuilding
// it took the × away between the two, so tabs could not be closed.
const tabEls = new Map(); // id -> { el, title, close }
function tabElement(id) {
  let entry = tabEls.get(id);
  if (entry) return entry;
  const el = document.createElement('div');
  el.setAttribute('role', 'tab');
  el.dataset.id = id;
  const title = document.createElement('span');
  title.className = 'title';
  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '×';
  close.addEventListener('click', (e) => { e.stopPropagation(); api.send('private:close-tab', id); });
  el.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('.close')) api.send('private:switch', id); });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) api.send('private:close-tab', id); });
  el.append(title, close);
  entry = { el, title, close };
  tabEls.set(id, entry);
  return entry;
}

function render(state) {
  const ids = new Set(state.tabs.map((t) => t.id));
  for (const [id, entry] of tabEls) if (!ids.has(id)) { entry.el.remove(); tabEls.delete(id); }
  state.tabs.forEach((t, i) => {
    const { el, title, close } = tabElement(t.id);
    el.className = `tab${t.active ? ' active' : ''}${t.loading ? ' loading' : ''}`;
    el.setAttribute('aria-selected', String(t.active));
    el.title = t.url || t.title;
    title.textContent = t.title;
    close.setAttribute('aria-label', `Close ${t.title}`);
    if (tabsEl.children[i] !== el) tabsEl.insertBefore(el, tabsEl.children[i] || null);
  });
  document.getElementById('back').disabled = !state.canBack;
  document.getElementById('forward').disabled = !state.canForward;
  if (!editing) address.value = state.url;
}

api.on('private:state', render);
api.on('private:focus-address', () => { address.focus(); address.select(); });
document.getElementById('new-tab').addEventListener('click', () => api.send('private:new-tab'));
document.getElementById('back').addEventListener('click', () => api.send('private:back'));
document.getElementById('forward').addEventListener('click', () => api.send('private:forward'));
document.getElementById('reload').addEventListener('click', () => api.send('private:reload'));
address.addEventListener('focus', () => { editing = true; address.select(); });
address.addEventListener('blur', () => { editing = false; });
address.addEventListener('keydown', (e) => { if (e.key === 'Escape') address.blur(); });
document.getElementById('address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!address.value.trim()) return;
  api.send('private:go', address.value);
  address.blur();
});
