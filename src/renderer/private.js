// The private window's UI: tab strip, back/forward/reload, the address box, find in page and this
// window's downloads. State comes from features/private-window.js; this page only draws it and sends
// clicks back. Strings come from locales/ (private.* keys) through renderer/i18n.js.
const api = window.privateUi;
const t = window.t || ((key) => key);
const tabsEl = document.getElementById('tabs');
const address = document.getElementById('address');
const security = document.getElementById('security');
const zoomChip = document.getElementById('zoom');
const reloadBtn = document.getElementById('reload');
const downloadsBtn = document.getElementById('downloads');
const find = document.getElementById('find');
const findText = document.getElementById('find-text');
const findCount = document.getElementById('find-count');
let edited = false; // typed in since it was focused: a page loading then leaves the box alone
let last = { tabs: [], url: '' };

if (api.platform === 'darwin') document.body.classList.add('mac');
const tr = (key, fallback, vars) => { const out = t(key, vars); return out === key ? fallback : out; };

const svg = (paths) => `<svg viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`;
const GLOBE = svg('<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.5 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 6 5.7 8s.7 3.9 2.3 5.5"/>');
const LOCK = svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>');
const WARN = svg('<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.3v.1"/>');
const SPEAKER = svg('<path d="M3 6.5h2.2L8.5 4v8L5.2 9.5H3z"/><path d="M10.7 6a2.8 2.8 0 0 1 0 4M12.3 4.5a5 5 0 0 1 0 7"/>');
const CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>';

// Tabs are kept and updated in place, never rebuilt: a click needs its button to survive from press to
// release, and pressing a tab (which switches to it) or a page loading re-renders the strip. Rebuilding
// it took the × away between the two, so tabs could not be closed.
const tabEls = new Map(); // id -> { el, icon, title, audio, close, favicon }
function tabElement(id) {
  let entry = tabEls.get(id);
  if (entry) return entry;
  const el = document.createElement('div');
  el.setAttribute('role', 'tab');
  el.dataset.id = id;
  const icon = document.createElement('span');
  icon.className = 'icon';
  const title = document.createElement('span');
  title.className = 'title';
  const audio = document.createElement('span');
  audio.className = 'audio';
  audio.innerHTML = SPEAKER;
  audio.hidden = true;
  const close = document.createElement('button');
  close.className = 'close';
  close.innerHTML = CLOSE;
  close.addEventListener('click', (e) => { e.stopPropagation(); api.send('private:close-tab', id); });
  el.addEventListener('pointerdown', (e) => startPress(e, id, el));
  el.addEventListener('auxclick', (e) => { if (e.button === 1) api.send('private:close-tab', id); });
  el.append(icon, title, audio, close);
  entry = { el, icon, title, audio, close, favicon: undefined };
  tabEls.set(id, entry);
  return entry;
}

// Press a tab to switch to it; drag it sideways to move it along the strip. A tab never leaves the strip:
// private tabs can't be dragged into another window, and nothing from a normal window drops in here.
let drag = null;
function startPress(e, id, el) {
  if (e.button !== 0 || e.target.closest('.close')) return;
  api.send('private:switch', id);
  drag = { id, el, startX: e.clientX, moved: false, pointerId: e.pointerId };
  el.setPointerCapture(e.pointerId);
}
function dropIndex(x) {
  const others = [...tabsEl.children].filter((child) => child !== drag.el);
  return others.filter((child) => { const r = child.getBoundingClientRect(); return r.left + r.width / 2 < x; }).length;
}
tabsEl.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.startX;
  if (!drag.moved && Math.abs(dx) < 5) return;
  drag.moved = true;
  drag.el.classList.add('dragging');
  drag.el.style.transform = `translateX(${dx}px)`;
});
const endDrag = (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { id, el, moved } = drag;
  if (moved && e.type === 'pointerup') api.send('private:move', { id, index: dropIndex(e.clientX) });
  el.classList.remove('dragging');
  el.style.transform = '';
  drag = null;
};
tabsEl.addEventListener('pointerup', endDrag);
tabsEl.addEventListener('pointercancel', endDrag);
tabsEl.addEventListener('lostpointercapture', endDrag);
// Nothing may be dropped into the private UI (a link or file dragged in from elsewhere would navigate it).
for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault());

function setIcon(entry, favicon) {
  if (entry.favicon === favicon) return;
  entry.favicon = favicon;
  entry.icon.textContent = '';
  if (favicon) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = favicon;
    img.addEventListener('error', () => { entry.icon.innerHTML = GLOBE; });
    entry.icon.append(img);
  } else entry.icon.innerHTML = GLOBE;
}

function markNarrow() {
  for (const { el } of tabEls.values()) el.classList.toggle('narrow', el.offsetWidth < 72);
}
new ResizeObserver(markNarrow).observe(tabsEl);

function renderSecurity(state) {
  const kind = state.security || '';
  security.className = `security ${kind}`;
  const label = {
    secure: tr('private.security.secure', 'Connection is secure'),
    mixed: tr('private.security.mixed', 'Parts of this page are not secure'),
    insecure: tr('private.security.notSecure', 'Not secure'),
    broken: tr('private.security.notSecure', 'Not secure'),
  }[kind] || '';
  security.innerHTML = kind === 'secure' || kind === 'mixed' ? LOCK : kind ? `${WARN}<span>${label}</span>` : '';
  security.title = label;
  security.setAttribute('aria-label', label);
  security.setAttribute('aria-hidden', String(!kind));
}

function render(state) {
  last = state;
  const ids = new Set(state.tabs.map((tab) => tab.id));
  for (const [id, entry] of tabEls) if (!ids.has(id)) { entry.el.remove(); tabEls.delete(id); }
  state.tabs.forEach((tab, i) => {
    const entry = tabElement(tab.id);
    const { el, title, close, audio } = entry;
    el.className = `tab${tab.active ? ' active' : ''}${tab.loading ? ' loading' : ''}${el.classList.contains('narrow') ? ' narrow' : ''}${drag?.el === el && drag.moved ? ' dragging' : ''}`;
    el.setAttribute('aria-selected', String(tab.active));
    el.title = tab.url ? `${tab.title}\n${tab.url}` : tab.title;
    title.textContent = tab.title;
    audio.hidden = !tab.audible;
    setIcon(entry, tab.favicon);
    const closeLabel = tr('private.closeTab', `Close ${tab.title}`, { title: tab.title });
    close.setAttribute('aria-label', closeLabel);
    close.title = tr('private.closeTab.short', 'Close tab');
    if (tabsEl.children[i] !== el) tabsEl.insertBefore(el, tabsEl.children[i] || null);
  });
  markNarrow();
  document.getElementById('back').disabled = !state.canBack;
  document.getElementById('forward').disabled = !state.canForward;
  reloadBtn.classList.toggle('loading', Boolean(state.loading));
  const reloadLabel = state.loading ? tr('private.stop', 'Stop loading') : tr('private.reload', 'Reload');
  reloadBtn.title = reloadLabel;
  reloadBtn.setAttribute('aria-label', reloadLabel);
  if (!edited || document.activeElement !== address) address.value = state.url;
  renderSecurity(state);
  const zoomed = state.url && /^https?:/i.test(state.url) && state.zoom && state.zoom !== (state.defaultZoom || 100);
  zoomChip.hidden = !zoomed;
  if (zoomed) zoomChip.textContent = `${state.zoom}%`;
  const d = state.downloads || { count: 0, running: 0, progress: null };
  downloadsBtn.hidden = !d.count;
  downloadsBtn.classList.toggle('running', d.running > 0);
  downloadsBtn.classList.toggle('done', d.count > 0 && d.running === 0);
  document.getElementById('downloads-fill').style.width = `${Math.round((d.progress ?? 0) * 100)}%`;
}

// ---- find in page ----
function openFind() {
  find.hidden = false;
  findText.focus();
  findText.select();
  if (findText.value) api.send('private:find', { text: findText.value });
}
function closeFind({ focusPage = true } = {}) {
  if (find.hidden) return;
  find.hidden = true;
  findCount.textContent = '';
  find.classList.remove('none');
  if (focusPage) api.send('private:find-stop');
}
function step(direction) {
  if (find.hidden || !findText.value) { openFind(); return; }
  api.send('private:find', { text: findText.value, forward: direction > 0, findNext: true });
}
findText.addEventListener('input', () => api.send('private:find', { text: findText.value }));
findText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
document.getElementById('find-next').addEventListener('click', () => step(1));
document.getElementById('find-prev').addEventListener('click', () => step(-1));
document.getElementById('find-close').addEventListener('click', () => closeFind());
api.on('private:find-open', openFind);
api.on('private:find-close', () => closeFind({ focusPage: false }));
api.on('private:find-step', step);
api.on('private:find-result', ({ active, total }) => {
  if (find.hidden) return;
  find.classList.toggle('none', Boolean(findText.value) && !total);
  findCount.textContent = !findText.value ? '' : total ? tr('private.find.count', `${active}/${total}`, { active, total }) : tr('private.find.none', 'No results');
});

api.on('private:state', render);
api.on('private:focus-address', () => { address.focus(); address.select(); });
api.on('private:fullscreen', (on) => document.body.classList.toggle('fullscreen', Boolean(on)));
document.getElementById('new-tab').addEventListener('click', () => api.send('private:new-tab'));
document.getElementById('back').addEventListener('click', () => api.send('private:back'));
document.getElementById('forward').addEventListener('click', () => api.send('private:forward'));
reloadBtn.addEventListener('click', () => api.send('private:reload'));
zoomChip.addEventListener('click', () => api.send('private:zoom-reset'));
downloadsBtn.addEventListener('click', () => {
  const r = downloadsBtn.getBoundingClientRect();
  api.send('private:downloads', { x: r.left, y: r.bottom });
});
address.addEventListener('focus', () => address.select());
address.addEventListener('input', () => { edited = true; });
address.addEventListener('blur', () => { edited = false; });
address.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Escape puts the address back as it was; a second one (or one on an untouched box) returns to the page.
  if (address.value !== last.url) { address.value = last.url; edited = false; address.select(); return; }
  address.blur();
  if (last.url) api.send('private:focus-page');
});
document.getElementById('address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!address.value.trim()) return;
  api.send('private:go', address.value);
  edited = false;
  address.blur();
});
