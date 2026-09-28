// The private window's UI: tab strip, back/forward/reload and the address box. State comes from
// features/private-window.js; this page only draws it and sends clicks back.
const api = window.privateUi;
const tabsEl = document.getElementById('tabs');
const address = document.getElementById('address');
let editing = false;

function render(state) {
  tabsEl.textContent = '';
  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className = `tab${t.active ? ' active' : ''}${t.loading ? ' loading' : ''}`;
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(t.active));
    el.dataset.id = t.id;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title;
    el.title = t.url || t.title;
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.setAttribute('aria-label', `Close ${t.title}`);
    close.addEventListener('click', (e) => { e.stopPropagation(); api.send('private:close-tab', t.id); });
    el.addEventListener('mousedown', (e) => { if (e.button === 0) api.send('private:switch', t.id); });
    el.addEventListener('auxclick', (e) => { if (e.button === 1) api.send('private:close-tab', t.id); });
    el.append(title, close);
    tabsEl.append(el);
  }
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
