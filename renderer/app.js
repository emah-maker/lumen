const $ = (id) => document.getElementById(id);

// ---------- layout: tell main where tab content goes ----------

const viewport = $('viewport');
let lastBounds = '';
// While the sidebar springs, the page view holds its final size: resizing a native page every
// frame makes the site reflow its whole layout each frame, which is what made pages stutter.
let heldRect = null;
function reportBounds() {
  const r = heldRect || viewport.getBoundingClientRect();
  const inset = document.body.classList.contains('agent-active') ? 2 : 0;
  const bounds = { x: r.left + inset, y: r.top + inset, width: r.width - inset * 2, height: r.height - inset * 2 };
  const key = `${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)}`;
  if (key === lastBounds) return; // called every frame during animations; only send changes
  lastBounds = key;
  window.browser.setContentBounds(bounds);
}
new ResizeObserver(reportBounds).observe(viewport);
window.addEventListener('resize', reportBounds);

// ---------- motion ----------

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const SPRING_SMOOTH = cssVar('--spring-smooth') || 'cubic-bezier(0.16, 1, 0.3, 1)';
const SPRING_SNAPPY = cssVar('--spring-snappy') || 'cubic-bezier(0.16, 1, 0.3, 1)';

// A damped spring (Apple's response/damping model) stepped per frame. It starts from the current
// value and velocity, so a new target mid-flight redirects the motion instead of restarting it.
function springTo(from, to, { response = 0.34, damping = 1, velocity = 0, onUpdate, onDone }) {
  const w0 = (2 * Math.PI) / response;
  const STEP = 1 / 480; // integrate in small fixed steps: stable however late a frame arrives
  let x = from, v = velocity, last = null, raf = 0;
  const tick = (now) => {
    if (last === null) last = now; // time starts at the first frame, not when the spring was made
    let dt = Math.min(1 / 50, (now - last) / 1000); // a late frame slows the motion, never jumps it
    last = now;
    while (dt > 0) {
      const h = Math.min(STEP, dt);
      v += (-w0 * w0 * (x - to) - 2 * damping * w0 * v) * h;
      x += v * h;
      dt -= h;
    }
    if (Math.abs(x - to) < 0.0015 && Math.abs(v) < 0.02) {
      x = to;
      onUpdate(to);
      onDone?.();
      return;
    }
    onUpdate(x);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return { stop: () => cancelAnimationFrame(raf), get velocity() { return v; } };
}

// ---------- tabs & navigation ----------

const address = $('address');
let addressDirty = false;
let currentUrl = '';
let currentError = false;
let lastActiveId = null;

const GLOBE = '<path d="M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5ZM1.75 8h12.5M8 1.75c1.7 1.8 2.5 3.9 2.5 6.25S9.7 12.45 8 14.25C6.3 12.45 5.5 10.35 5.5 8S6.3 3.55 8 1.75Z"/>';
const LOCK = '<svg viewBox="0 0 12 12"><rect x="2.5" y="5.25" width="7" height="5" rx="1"/><path d="M4 5.25V4a2 2 0 0 1 4 0v1.25"/></svg>';
const WARN = '<svg viewBox="0 0 12 12"><path d="M6 1.5 11 10.5H1Z"/><path d="M6 5v2.25M6 8.75v.01"/></svg>';

function globeIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'tab-favicon globe');
  svg.innerHTML = GLOBE;
  return svg;
}

// Unfocused address bar shows a trimmed URL; the full URL returns on focus.
function prettyUrl(url) {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
}

function showAddress() {
  const security = $('security');
  if (document.activeElement === address) return;
  address.value = /^https?:/.test(currentUrl) ? prettyUrl(currentUrl) : currentUrl;
  if (currentError) {
    security.hidden = true; // an error page has no connection to vouch for
  } else if (currentUrl.startsWith('https:')) {
    security.className = 'security';
    security.innerHTML = LOCK;
    security.title = 'Secure connection';
    security.hidden = false;
  } else if (currentUrl.startsWith('http:')) {
    security.className = 'security insecure';
    security.innerHTML = WARN + '<span>Not secure</span>';
    security.title = 'This connection is not encrypted';
    security.hidden = false;
  } else {
    security.hidden = true;
  }
}

// ---------- tab reordering (pointer drag) ----------

let drag = null; // { el, id, startX, dx, moved, rects, from, to }
let pendingState = null; // tab updates that arrive mid-drag are applied on release
let suppressClick = false;

function startTabDrag(e, el, id) {
  if (e.button !== 0 || e.target.closest('.tab-close')) return;
  const tabs = [...$('tabs').querySelectorAll('.tab')];
  drag = { el, id, startX: e.clientX, dx: 0, moved: false, ids: tabs.map((t) => Number(t.dataset.id)), rects: tabs.map((t) => t.getBoundingClientRect()), from: tabs.indexOf(el) };
  drag.to = drag.from;
  el.setPointerCapture(e.pointerId);
}

function moveTabDrag(e) {
  if (!drag) return;
  drag.dx = e.clientX - drag.startX;
  if (!drag.moved && Math.abs(drag.dx) < 5) return;
  if (!drag.moved) {
    drag.moved = true;
    drag.el.classList.add('dragging');
    $('tabs').classList.add('reordering');
  }
  const { rects, from } = drag;
  const first = rects[0].left, last = rects[rects.length - 1].right;
  const dx = Math.max(first - rects[from].left, Math.min(last - rects[from].right, drag.dx));
  drag.el.style.transform = `translateX(${dx}px)`;
  const center = rects[from].left + rects[from].width / 2 + dx;
  let to = rects.findIndex((r) => center < r.left + r.width / 2);
  if (to === -1) to = rects.length - 1;
  else if (to > from) to -= 1;
  drag.to = to;
  // Neighbours slide aside to show where the tab will land.
  const shift = rects[from].width + 2;
  [...$('tabs').querySelectorAll('.tab')].forEach((t, i) => {
    if (t === drag.el) return;
    const offset = from < to && i > from && i <= to ? -shift : from > to && i >= to && i < from ? shift : 0;
    t.style.transform = offset ? `translateX(${offset}px)` : '';
  });
}

function endTabDrag() {
  if (!drag) return;
  const { moved, from, to, id, ids } = drag;
  drag = null;
  $('tabs').classList.remove('reordering');
  [...$('tabs').children].forEach((t) => { t.style.transform = ''; t.classList.remove('dragging'); });
  if (moved) {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (from !== to) {
      // Collapsed groups hide tabs, so the strip's order isn't the full order: land next to the tab we dropped on.
      const without = (lastTabState?.tabs || []).map((t) => t.id).filter((x) => x !== id);
      const index = without.indexOf(ids[to]);
      window.browser.moveTab?.(id, index === -1 ? to : index + (to > from ? 1 : 0));
    }
  }
  if (pendingState) {
    const state = pendingState;
    pendingState = null;
    renderTabs(state);
  }
}

// One surface that glides to the active tab.
let tabIndicator = null;
let tabsRendered = false;

function placeIndicator(animate) {
  const active = $('tabs').querySelector('.tab.active');
  if (!tabIndicator) return;
  tabIndicator.style.opacity = active ? '' : '0';
  if (!active) return;
  tabIndicator.classList.toggle('instant', !animate);
  tabIndicator.style.transform = `translateX(${active.offsetLeft}px)`;
  tabIndicator.style.width = `${active.offsetWidth}px`;
  if (!animate) requestAnimationFrame(() => tabIndicator.classList.remove('instant'));
}
new ResizeObserver(() => placeIndicator(false)).observe($('tabs'));

// Tabs are rebuilt on every state change; FLIP makes that read as tabs moving, arriving and leaving.
function animateTabs(before, container) {
  const animate = tabsRendered && !reduceMotion.matches;
  const seen = new Set();
  for (const el of container.querySelectorAll('.tab, .group-label')) {
    seen.add(el.dataset.id);
    if (!animate) continue;
    const prev = before.get(el.dataset.id);
    if (prev) {
      const dx = prev.rect.left - el.getBoundingClientRect().left;
      if (Math.abs(dx) > 0.5) el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 420, easing: SPRING_SMOOTH });
    } else {
      el.animate([{ opacity: 0, transform: 'translateY(3px) scale(0.86)' }, { opacity: 1, transform: 'none' }], { duration: 480, easing: SPRING_SNAPPY });
    }
  }
  if (!animate) return;
  // Closed tabs leave as ghosts at their old position while the neighbours slide in.
  for (const [id, { el, rect }] of before) {
    if (seen.has(id)) continue;
    el.classList.remove('active');
    el.classList.add('tab-ghost');
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    document.body.append(el);
    el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.82)' }], { duration: 170, easing: 'cubic-bezier(0.4, 0, 1, 1)' })
      .finished.then(() => el.remove(), () => el.remove());
  }
}

let lastTabState = null;
let renamingGroup = null; // a group label being renamed holds tab-strip updates until it's done

function groupLabel(group, count, crowded) {
  const label = document.createElement('button');
  label.type = 'button';
  label.className = 'group-label' + (group.collapsed ? ' collapsed' : '') + (crowded ? ' crowded' : '');
  label.dataset.id = `g${group.id}`;
  label.dataset.group = String(group.id);
  label.style.setProperty('--group-color', `var(--g-${group.color})`);
  label.setAttribute('aria-expanded', String(!group.collapsed));
  label.setAttribute('aria-label', `Group ${group.name}, ${count} tab${count === 1 ? '' : 's'}`);
  label.title = `${group.name}: click to ${group.collapsed ? 'expand' : 'collapse'}, right-click for options`;
  const name = Object.assign(document.createElement('span'), { className: 'group-name', textContent: group.name });
  const badge = Object.assign(document.createElement('span'), { className: 'group-count', textContent: String(count) });
  label.append(name, badge);
  label.onclick = () => window.browser.toggleGroup(group.id);
  label.oncontextmenu = (e) => { e.preventDefault(); window.browser.groupMenu(group.id, { x: e.clientX, y: e.clientY }); };
  return label;
}

function startRename(groupId) {
  const label = $('tabs').querySelector(`.group-label[data-group="${groupId}"]`);
  const group = lastTabState?.groups?.find((g) => g.id === groupId);
  if (!label || !group) return;
  renamingGroup = groupId;
  const input = Object.assign(document.createElement('input'), { value: group.name, maxLength: 40 });
  input.setAttribute('aria-label', 'Group name');
  label.querySelector('.group-name').replaceWith(input);
  label.onclick = null;
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    renamingGroup = null;
    window.browser.renameGroup(groupId, save && input.value.trim() ? input.value.trim() : group.name);
    if (pendingState) {
      const held = pendingState;
      pendingState = null;
      renderTabs(held);
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.focus();
  input.select();
}
window.browser.onRenameGroup?.((groupId) => requestAnimationFrame(() => startRename(groupId)));

const organizeBtn = $('organize-tabs');
organizeBtn.onclick = () => window.browser.organizeTabs();
window.browser.onOrganizing?.((busy) => {
  organizeBtn.classList.toggle('busy', busy);
  organizeBtn.disabled = busy;
  organizeBtn.querySelector('span').textContent = busy ? 'Organizing…' : 'Organize';
});

function renderTabs(state) {
  if (drag || renamingGroup !== null) {
    pendingState = state;
    return;
  }
  lastTabState = state;
  const container = $('tabs');
  const before = new Map();
  for (const el of container.querySelectorAll('.tab, .group-label')) before.set(el.dataset.id, { el, rect: el.getBoundingClientRect() });
  container.querySelectorAll('.tab, .group-label').forEach((el) => el.remove());
  const groupsById = new Map((state.groups || []).map((g) => [g.id, g]));
  const crowded = state.tabs.length > 12;
  let currentGroup = null;
  const ungroupedWeb = state.tabs.filter((t) => !t.groupId && t.url).length;
  organizeBtn.hidden = ungroupedWeb < 8 && !organizeBtn.classList.contains('busy');
  if (!tabIndicator) {
    tabIndicator = Object.assign(document.createElement('div'), { className: 'tab-indicator instant' });
    tabIndicator.setAttribute('aria-hidden', 'true');
    container.prepend(tabIndicator);
  }
  for (const tab of state.tabs) {
    const group = tab.groupId ? groupsById.get(tab.groupId) : null;
    if (group && currentGroup !== group.id) {
      container.append(groupLabel(group, state.tabs.filter((t) => t.groupId === group.id).length, crowded));
    }
    currentGroup = group ? group.id : null;
    if (group?.collapsed && tab.id !== state.activeId) continue; // the active tab stays visible
    const el = document.createElement('div');
    el.dataset.id = String(tab.id);
    el.className = 'tab' + (tab.id === state.activeId ? ' active' : '') + (group ? ' grouped' : '');
    if (group) el.style.setProperty('--group-color', `var(--g-${group.color})`);
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(tab.id === state.activeId));
    el.title = tab.title;
    const inner = document.createElement('div');
    inner.className = 'tab-inner';

    let icon;
    if (tab.loading) {
      icon = document.createElement('span');
      icon.className = 'tab-favicon spinner';
    } else if (tab.favicon && !tab.error) {
      icon = document.createElement('img');
      icon.className = 'tab-favicon';
      icon.src = tab.favicon;
      icon.onerror = () => icon.replaceWith(globeIcon());
    } else {
      icon = globeIcon();
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title;

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.setAttribute('aria-label', `Close ${tab.title}`);
    close.innerHTML = '<svg viewBox="0 0 10 10"><path d="M2 2l6 6M8 2 2 8"/></svg>';
    close.onclick = (e) => { e.stopPropagation(); window.browser.closeTab(tab.id); };

    inner.append(icon, title, close);
    el.append(inner);
    el.onclick = () => { if (!suppressClick) window.browser.switchTab(tab.id); };
    el.onauxclick = (e) => { if (e.button === 1) window.browser.closeTab(tab.id); };
    el.oncontextmenu = (e) => { e.preventDefault(); window.browser.tabMenu(tab.id, { x: e.clientX, y: e.clientY }); };
    el.addEventListener('pointerdown', (e) => startTabDrag(e, el, tab.id));
    el.addEventListener('pointermove', moveTabDrag);
    el.addEventListener('pointerup', endTabDrag);
    el.addEventListener('pointercancel', endTabDrag);
    container.append(el);
  }

  animateTabs(before, container);
  const activeId = container.querySelector('.tab.active')?.dataset.id;
  placeIndicator(tabsRendered && !reduceMotion.matches && [...before.keys()].includes(activeId));
  tabsRendered = true;

  const activeEl = container.querySelector('.tab.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });

  const active = state.tabs.find((t) => t.id === state.activeId);
  if (state.activeId !== lastActiveId) {
    lastActiveId = state.activeId;
    closeFind();
  }
  currentError = Boolean(active?.error);
  const zoom = active?.zoom ?? 100;
  $('zoom').hidden = zoom === 100;
  $('zoom').textContent = `${zoom}%`;
  document.body.classList.toggle('zoomed', zoom !== 100);
  const star = $('bookmark');
  star.hidden = !active?.url || currentError;
  star.setAttribute('aria-pressed', String(Boolean(active?.bookmarked)));
  star.title = active?.bookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
  star.setAttribute('aria-label', active?.bookmarked ? 'Remove bookmark' : 'Bookmark this page');
  if (active && (!addressDirty || document.activeElement !== address)) {
    currentUrl = active.url;
    addressDirty = false;
    if (document.activeElement === address) address.value = currentUrl;
    else showAddress();
  }
  $('loadbar').hidden = !active?.loading;
  document.body.classList.toggle('tab-loading', Boolean(active?.loading));
  $('back').disabled = !state.canGoBack;
  $('forward').disabled = !state.canGoForward;
  $('reload-icon').innerHTML = active?.loading
    ? '<path d="M4 4l8 8M12 4l-8 8"/>'
    : '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5"/>';
  $('reload').title = active?.loading ? 'Stop' : 'Reload (Ctrl+R)';
}

window.browser.onTabs(renderTabs);
window.browser.onFocusAddress(() => { address.focus(); address.select(); });

// ---------- address bar suggestions (history + inline completion) ----------

let suggest = { items: [], selected: -1, typed: '' };
let suggestSeq = 0;
let searchEngine = { label: 'Google', url: 'https://www.google.com/search?q=%s' };
const searchUrl = (text) => searchEngine.url.replace('%s', encodeURIComponent(text));

function renderSuggestions() {
  if (!suggest.items.length) {
    window.browser.hideSuggestions();
    return;
  }
  // The view is larger than the list by SUGGEST_PAD on each side (see suggest.html) so the
  // list's shadow isn't clipped; the list itself lines up with the address field.
  const SUGGEST_PAD = { x: 16, top: 6, bottom: 24 };
  const r = $('omnibox').getBoundingClientRect();
  window.browser.showSuggestions(
    {
      x: r.left - SUGGEST_PAD.x,
      y: r.bottom + 4 - SUGGEST_PAD.top,
      width: r.width + SUGGEST_PAD.x * 2,
      height: suggest.items.length * 36 + 10 + SUGGEST_PAD.top + SUGGEST_PAD.bottom,
    },
    { items: suggest.items.map(({ kind, title, detail }) => ({ kind, title, detail })), selected: suggest.selected },
  );
}

function hideSuggestions() {
  suggestSeq++;
  suggest = { items: [], selected: -1, typed: '' };
  window.browser.hideSuggestions();
}

async function updateSuggestions(typed, deleting) {
  const seq = ++suggestSeq;
  const text = typed.trim();
  if (!text) return hideSuggestions();
  const history = await window.browser.suggest(text);
  if (seq !== suggestSeq || document.activeElement !== address) return;

  if (!deleting && history.length && !/\s/.test(typed)) {
    const bare = history[0].url.replace(/^https?:\/\/(www\.)?/i, '');
    const completion = typed.includes('/') ? bare.replace(/\/$/, '') : bare.split('/')[0];
    if (completion.toLowerCase().startsWith(typed.toLowerCase()) && completion.length > typed.length) {
      address.value = typed + completion.slice(typed.length);
      address.setSelectionRange(typed.length, address.value.length);
    }
  }

  const search = { kind: 'search', title: text, detail: `${searchEngine.label} Search`, go: searchUrl(text) };
  const visited = history.map((h) => ({ kind: 'history', title: h.title || prettyUrl(h.url), detail: prettyUrl(h.url), go: h.url }));
  suggest = { items: /\s/.test(text) || !visited.length ? [search, ...visited] : [...visited, search], selected: -1, typed };
  renderSuggestions();
}

function moveSelection(step) {
  const count = suggest.items.length;
  if (!count) return;
  suggest.selected = ((suggest.selected + 1 + step + count + 1) % (count + 1)) - 1; // -1 = what the user typed
  const item = suggest.items[suggest.selected];
  address.value = !item ? suggest.typed : item.kind === 'search' ? item.title : item.go;
  renderSuggestions();
}

function navigate(target) {
  hideSuggestions();
  addressDirty = false;
  if (target) window.browser.go(target);
  address.blur();
}

window.browser.onSuggestionPicked((index) => {
  const item = suggest.items[index];
  if (item) navigate(item.go);
});

address.addEventListener('input', (e) => {
  addressDirty = true;
  updateSuggestions(address.value, e.inputType?.startsWith('delete'));
});
address.addEventListener('focus', () => {
  if (!addressDirty) address.value = currentUrl;
  address.select();
});
address.addEventListener('blur', () => {
  setTimeout(() => { if (document.activeElement !== address) hideSuggestions(); }, 150); // let a dropdown pick land first
  if (!addressDirty) showAddress();
});
address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.altKey) {
    e.preventDefault();
    const text = address.value.trim();
    hideSuggestions();
    if (text) { showSidebar(true); ask(text); }
    addressDirty = false;
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!suggest.items.length) return;
    e.preventDefault();
    moveSelection(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Escape') {
    if (suggest.items.length) {
      address.value = suggest.typed;
      hideSuggestions();
      return;
    }
    addressDirty = false;
    address.blur();
    showAddress();
  }
});
$('omnibox').addEventListener('submit', (e) => {
  e.preventDefault();
  const item = suggest.items[suggest.selected];
  navigate(item ? item.go : address.value.trim());
});

$('back').onclick = () => window.browser.back();
$('forward').onclick = () => window.browser.forward();
$('reload').onclick = () => window.browser.reload();
$('zoom').onclick = () => window.browser.resetZoom?.();
$('bookmark').onclick = () => window.browser.toggleBookmark?.();
$('new-tab').onclick = () => { window.browser.newTab(); address.focus(); };
$('app-menu').onclick = () => {
  const r = $('app-menu').getBoundingClientRect();
  window.browser.openAppMenu?.({ x: Math.round(r.left), y: Math.round(r.bottom) });
};
$('agent-stop').onclick = () => window.assistant.stop();

// ---------- find in page ----------

const findbar = $('findbar');
const findInput = $('find-input');

// The bar opens by growing its row, so the page view (which follows the viewport) eases down with it.
let findHideTimer = null;

function openFind() {
  clearTimeout(findHideTimer);
  findbar.hidden = false;
  requestAnimationFrame(() => findbar.classList.add('open'));
  findInput.focus();
  findInput.select();
  if (findInput.value) window.browser.find(findInput.value, { forward: true, findNext: false });
}

function closeFind() {
  if (findbar.hidden || !findbar.classList.contains('open')) return;
  findbar.classList.remove('open', 'no-match');
  $('find-count').textContent = '';
  window.browser.stopFind();
  clearTimeout(findHideTimer);
  findHideTimer = setTimeout(() => { if (!findbar.classList.contains('open')) findbar.hidden = true; }, reduceMotion.matches ? 0 : 420);
}

function findStep(forward) {
  if (findInput.value) window.browser.find(findInput.value, { forward, findNext: true });
}

window.browser.onOpenFind(openFind);
window.browser.onFindResult(({ activeMatchOrdinal, matches }) => {
  $('find-count').textContent = findInput.value ? (matches ? `${activeMatchOrdinal} of ${matches}` : 'No matches') : '';
  findbar.classList.toggle('no-match', Boolean(findInput.value) && !matches);
});
findInput.addEventListener('input', () => {
  if (findInput.value) window.browser.find(findInput.value, { forward: true, findNext: false });
  else {
    window.browser.stopFind();
    $('find-count').textContent = '';
    findbar.classList.remove('no-match');
  }
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(!e.shiftKey); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('find-next').onclick = () => findStep(true);
$('find-prev').onclick = () => findStep(false);
$('find-close').onclick = closeFind;

// ---------- sidebar ----------

// The sidebar springs open from the window's trailing edge. Its width follows --reveal (0–1) each
// frame and the native page view is resized with it, so the page makes room instead of jumping.
let reveal = document.body.classList.contains('sidebar-hidden') ? 0 : 1;
let revealAnim = null;

// Paint the hidden sidebar once while idle so the first open doesn't pay for building its layers.
if (document.body.classList.contains('sidebar-hidden')) {
  (window.requestIdleCallback || setTimeout)(() => {
    const el = $('sidebar');
    el.classList.add('prewarm');
    setTimeout(() => el.classList.remove("prewarm"), 250); // several painted frames, not just three
    window.browser.warmView?.();
    // Decode a throwaway image the size of the page so the first snapshot's decode is warm too.
    const r = viewport.getBoundingClientRect();
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });
    const img = new Image();
    img.className = 'page-snapshot';
    img.src = canvas.toDataURL('image/jpeg', 0.5);
    // Show it (under the live page, which covers the viewport) for a few frames: the first
    // full-size image upload is the slow part of the first sidebar animation.
    img.decode().then(() => {
      img.style.cssText = `width:${r.width}px;height:${r.height}px;opacity:0.01`;
      viewport.append(img);
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => img.remove())));
    }).catch(() => {});
  }, { timeout: 1500 });
}

// Viewport rect with the sidebar at reveal x, measured without painting.
function viewportAt(x) {
  const sidebar = $('sidebar');
  const before = sidebar.style.getPropertyValue('--reveal');
  sidebar.style.setProperty('--reveal', String(x));
  const r = viewport.getBoundingClientRect();
  if (before) sidebar.style.setProperty('--reveal', before);
  else sidebar.style.removeProperty('--reveal');
  return r;
}

function setReveal(x) {
  reveal = x;
  $('sidebar').style.setProperty('--reveal', String(Math.min(1, Math.max(0, x))));
  reportBounds();
}

// The page snapshot shown while the sidebar moves (see view:freeze in main.js).
let snapshot = null;
let freezeToken = 0;
let earlyFreeze = null; // a snapshot started on pointerdown

// Average colour of the snapshot's right edge: fills the strip a closing sidebar uncovers.
function edgeColor(img) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 24;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, img.naturalWidth - 2, 0, 2, img.naturalHeight, 0, 0, 1, 24);
    const d = ctx.getImageData(0, 0, 1, 24).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
  } catch {
    return '';
  }
}

async function freezePage() {
  const token = ++freezeToken;
  const src = await window.browser.freezeView?.();
  if (!src || token !== freezeToken) return;
  const r = viewport.getBoundingClientRect();
  const img = new Image();
  img.className = 'page-snapshot';
  img.alt = '';
  img.src = src;
  img.style.width = `${r.width}px`;
  img.style.height = `${r.height}px`;
  await img.decode().catch(() => {});
  if (token !== freezeToken) return;
  snapshot?.remove();
  snapshot = img;
  viewport.style.setProperty('--snapshot-edge', edgeColor(img));
  viewport.append(img);
}

function thawPage() {
  freezeToken++;
  const img = snapshot;
  snapshot = null;
  // Swap the live page back a frame after the motion has settled, not on its last frame.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.browser.thawView?.();
    if (img) setTimeout(() => { img.remove(); viewport.style.removeProperty('--snapshot-edge'); }, 80);
  }));
}

async function showSidebar(visible) {
  const body = document.body;
  $('sidebar').classList.remove('prewarm'); // never animate from the warm-up layout
  $('toggle-sidebar').setAttribute('aria-pressed', String(visible));
  if (earlyFreeze) {
    const pending = earlyFreeze;
    earlyFreeze = null;
    await pending;
  } else if (!revealAnim && !reduceMotion.matches && !snapshot) {
    await freezePage();
    if ($('toggle-sidebar').getAttribute('aria-pressed') !== String(visible)) return; // toggled again while capturing
  }
  const velocity = revealAnim?.velocity || 0;
  revealAnim?.stop();
  revealAnim = null;
  if (visible && body.classList.contains('sidebar-hidden')) {
    setReveal(0);
    body.classList.remove('sidebar-hidden');
  }
  const target = visible ? 1 : 0;
  // Opening: the page takes its narrower size now and the sidebar slides into the space.
  // Closing: the page keeps its size until the sidebar has gone, then widens once.
  heldRect = visible ? viewportAt(1) : viewport.getBoundingClientRect();
  reportBounds();
  const finish = () => {
    revealAnim = null;
    heldRect = null;
    thawPage();
    if (visible) $('sidebar').style.removeProperty('--reveal');
    else {
      body.classList.add('sidebar-hidden');
      $('sidebar').style.removeProperty('--reveal');
    }
    reveal = target;
    reportBounds();
  };
  if (reduceMotion.matches) finish();
  else {
    // Starting from rest: let the first layout/paint of the sidebar and snapshot land before
    // motion begins, so any slow frame is a still frame, not a jump.
    revealAnim = springTo(reveal, target, { response: visible ? 0.34 : 0.28, velocity, onUpdate: setReveal, onDone: finish });
  }
  if (visible) $('prompt').focus({ preventScroll: true });
}
$('toggle-sidebar').onclick = () => showSidebar($('toggle-sidebar').getAttribute('aria-pressed') !== 'true');
// Start the page snapshot as soon as the button is pressed; the click arrives a little later.
$('toggle-sidebar').addEventListener('pointerdown', (e) => {
  if (e.button === 0 && !revealAnim && !snapshot && !reduceMotion.matches) earlyFreeze = freezePage();
});

// Resizable from the sidebar's left edge; the width is remembered.
const SIDEBAR_MIN = 300, SIDEBAR_MAX = 560;
function setSidebarWidth(width) {
  const w = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
  document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
  reportBounds();
  return w;
}
const savedWidth = Number(localStorage.getItem('sidebarWidth'));
if (savedWidth) setSidebarWidth(savedWidth);
const resizer = $('sidebar-resize');
resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = $('sidebar').getBoundingClientRect().width;
  resizer.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const move = (ev) => setSidebarWidth(startWidth + (startX - ev.clientX));
  const up = () => {
    resizer.removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    localStorage.setItem('sidebarWidth', String(Math.round($('sidebar').getBoundingClientRect().width)));
  };
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', up, { once: true });
  resizer.addEventListener('pointercancel', up, { once: true });
});
resizer.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const width = setSidebarWidth($('sidebar').getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 20 : -20));
  localStorage.setItem('sidebarWidth', String(width));
});
window.browser.onToggleSidebar(() => showSidebar($('toggle-sidebar').getAttribute('aria-pressed') !== 'true'));
window.browser.onAskSelection((text) => {
  showSidebar(true);
  ask(`About this text from the page:\n\n"${text}"\n\nExplain it in context.`);
});

// ---------- settings ----------

const KEY_HINTS = {
  openai: { placeholder: 'sk-…', where: 'platform.openai.com' },
  xai: { placeholder: 'xai-…', where: 'console.x.ai' },
  gemini: { placeholder: 'AIza…', where: 'aistudio.google.com' },
};

function renderProviderKeys(providerKeys = {}) {
  const box = $('provider-keys');
  box.replaceChildren();
  for (const [provider, info] of Object.entries(providerKeys)) {
    const row = document.createElement('div');
    row.className = 'provider-row';
    const label = Object.assign(document.createElement('label'), { className: 'provider-name', textContent: info.label, htmlFor: `key-${provider}` });
    const input = Object.assign(document.createElement('input'), {
      id: `key-${provider}`,
      type: 'password',
      autocomplete: 'off',
      placeholder: info.stored ? '•••••••• saved' : info.env ? 'using environment variable' : KEY_HINTS[provider]?.placeholder || 'API key',
    });
    input.setAttribute('aria-label', `${info.label} API key`);
    const save = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: 'Save' });
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Remove', hidden: !info.stored });
    const status = Object.assign(document.createElement('p'), { className: 'hint provider-status' });
    status.textContent = info.stored || info.env ? 'Ready. Its models are in the model menu.' : `Get a key at ${KEY_HINTS[provider]?.where || 'the provider'}.`;
    save.onclick = async () => {
      const key = input.value.trim();
      if (!key) return input.focus();
      save.disabled = true;
      status.textContent = 'Saving and loading models…';
      try {
        await window.assistant.setProviderKey(provider, key);
        input.value = '';
        refreshSettings();
      } catch (err) {
        status.textContent = err.message;
      } finally {
        save.disabled = false;
      }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
    remove.onclick = async () => { await window.assistant.setProviderKey(provider, null); refreshSettings(); };
    row.append(label, input, save, remove, status);
    box.append(row);
  }
}

// Search engines as a radio grid with a coloured monogram each (arrow keys move the choice).
const ENGINE_COLORS = { google: '#4285f4', duckduckgo: '#de5833', bing: '#0c8484', brave: '#fb542b', ecosia: '#1f9d55', startpage: '#6573ff' };

function renderEnginePicker(engines, selectedId) {
  const group = $('search-engine');
  group.replaceChildren();
  engines.forEach((e) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'engine';
    button.dataset.id = e.id;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(e.id === selectedId));
    button.tabIndex = e.id === selectedId ? 0 : -1;
    button.style.setProperty('--engine', ENGINE_COLORS[e.id] || 'var(--accent)');
    const mono = Object.assign(document.createElement('span'), { className: 'mono', textContent: e.label[0] });
    mono.setAttribute('aria-hidden', 'true');
    button.append(mono, Object.assign(document.createElement('span'), { className: 'label', textContent: e.label }));
    button.onclick = () => chooseEngine(e.id, engines);
    group.append(button);
  });
}

function chooseEngine(id, engines) {
  for (const b of $('search-engine').querySelectorAll('.engine')) {
    const on = b.dataset.id === id;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  const chosen = engines?.find((e) => e.id === id);
  if (chosen) searchEngine = chosen;
  window.assistant.setSearchEngine(id);
}

$('search-engine').addEventListener('keydown', (e) => {
  const buttons = [...$('search-engine').querySelectorAll('.engine')];
  const i = buttons.indexOf(document.activeElement);
  if (i === -1) return;
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const next = buttons[(i + step + buttons.length) % buttons.length];
  next.focus();
  next.click();
});

async function renderSearchAndImport(s) {
  renderEnginePicker(s.searchEngines, s.searchEngine);
  const current = s.searchEngines.find((e) => e.id === s.searchEngine);
  if (current) searchEngine = current;
  const row = $('import-row');
  const browsers = await window.assistant.importBrowsers();
  row.replaceChildren();
  if (!browsers.length) row.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'No other browsers found on this computer.' }));
  for (const b of browsers) {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: b.label });
    button.onclick = async () => {
      button.disabled = true;
      await window.assistant.importFrom(b.id);
      button.disabled = false;
    };
    row.append(button);
  }
}
window.assistant.onSearchEngine?.((engine) => {
  searchEngine = engine;
  // Chosen from the ⋯ menu: reflect it in the picker.
  window.assistant.getSettings().then((s) => {
    for (const b of $('search-engine').querySelectorAll('.engine')) {
      b.setAttribute('aria-checked', String(b.dataset.id === s.searchEngine));
      b.tabIndex = b.dataset.id === s.searchEngine ? 0 : -1;
    }
  });
});
window.assistant.getSettings().then((s) => {
  const current = s.searchEngines?.find((e) => e.id === s.searchEngine);
  if (current) searchEngine = current;
});

async function refreshCli(status) {
  const s = status || await window.assistant.cliStatus?.();
  if (!s) return;
  $('cli-login').hidden = s.signedIn;
  $('cli-logout').hidden = !s.signedIn;
  $('cli-status').textContent = s.signedIn
    ? `Signed in with the Anthropic CLI (profile "${s.profile}").${s.shadowedBy ? ` Your ${s.shadowedBy} is used instead while it's set.` : ''}`
    : s.installed ? `Opens anthropic.com in your browser to sign in. Uses ${s.path}.` : 'Installs Anthropic\'s official CLI once, then opens anthropic.com to sign in.';
}
$('cli-login').onclick = async () => {
  const button = $('cli-login');
  button.disabled = true;
  try {
    const result = await window.assistant.cliLogin();
    await refreshCli(result);
    if (!result.ok && result.message) $('cli-status').textContent = result.message;
  } finally {
    button.disabled = false;
  }
};
$('cli-logout').onclick = async () => refreshCli(await window.assistant.cliLogout());
window.assistant.onCliProgress?.((text) => { $('cli-status').textContent = text; });

async function refreshSettings() {
  const s = await window.assistant.getSettings();
  refreshCli();
  renderSearchAndImport(s);
  renderProviderKeys(s.providerKeys);
  loadModels();
  $('adhd-mode').checked = s.adhdMode;
  $('auto-groups').checked = s.autoGroupTabs !== false;
  $('clear-key').hidden = !s.hasStoredKey;
  $('key-status').textContent = s.hasStoredKey
    ? 'A key is saved (encrypted with your OS keychain).'
    : s.hasEnvKey
      ? 'Using ANTHROPIC_API_KEY from the environment.'
      : 'No key saved. Get one at console.anthropic.com.';
}
$('adhd-mode').addEventListener('change', (e) => window.assistant.setAdhdMode(e.target.checked));
$('auto-groups').addEventListener('change', (e) => window.assistant.setAutoGroup(e.target.checked));

// ---------- model picker ----------

// ---------- the toolbar AI button follows the model's company ----------

// Simple monochrome marks (drawn here, sized for 16px), tinted per company.
const ASSISTANTS = {
  Claude: {
    name: 'Claude',
    tint: '#d97757',
    svg: '<svg viewBox="0 0 16 16" class="mark"><path d="M8 2.5v11M2.5 8h11M4.1 4.1l7.8 7.8M11.9 4.1l-7.8 7.8"/></svg>',
  },
  OpenAI: {
    name: 'ChatGPT',
    tint: 'currentColor',
    svg: '<svg viewBox="0 0 16 16" class="mark"><g transform="translate(8 8)"><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4"/><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4" transform="rotate(60)"/><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4" transform="rotate(120)"/><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4" transform="rotate(180)"/><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4" transform="rotate(240)"/><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4" transform="rotate(300)"/></g></svg>',
  },
  Grok: {
    name: 'Grok',
    tint: 'currentColor',
    svg: '<svg viewBox="0 0 16 16" class="mark"><path d="M3.2 13.4 12.8 2.6" stroke-width="1.8"/><path d="M3.4 2.6 6.9 6.8"/><path d="M9.1 9.2 12.6 13.4"/></svg>',
  },
  Gemini: {
    name: 'Gemini',
    tint: 'url(#gemini-grad)',
    svg: '<svg viewBox="0 0 16 16" class="mark filled"><defs><linearGradient id="gemini-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f8cff"/><stop offset="1" stop-color="#a86bff"/></linearGradient></defs><path d="M8 1.6C8.5 5 11 7.5 14.4 8 11 8.5 8.5 11 8 14.4 7.5 11 5 8.5 1.6 8 5 7.5 7.5 5 8 1.6Z"/></svg>',
  },
};
let assistantIdentity = null;

function setAssistantIdentity(group) {
  if (window.webAiBrand) group = window.webAiBrand; // a web panel (renderer/webai.js) decides the mark
  const who = ASSISTANTS[group] || ASSISTANTS.Claude;
  if (assistantIdentity === who) return;
  const first = assistantIdentity === null;
  assistantIdentity = who;
  const button = $('toggle-sidebar');
  button.title = `${who.name} (Ctrl+J)`;
  button.dataset.assistant = who.name;
  button.setAttribute('aria-label', who.name);
  button.style.setProperty('--assistant-tint', who.tint);
  const swap = () => {
    button.querySelector('svg')?.remove();
    button.insertAdjacentHTML('afterbegin', who.svg);
  };
  if (first || reduceMotion.matches) swap();
  else {
    // Cross-fade: the old mark shrinks away, the new one springs in.
    button.classList.add('mark-out');
    setTimeout(() => { swap(); button.classList.remove('mark-out'); button.classList.add('mark-in'); setTimeout(() => button.classList.remove('mark-in'), 420); }, 120);
  }
  const empty = document.querySelector('#empty .empty-title');
  if (empty) empty.innerHTML = `<span class="glow">Ask anything.</span> Or give ${who.name} a task on this page.`;
  const pill = $('agent-pill-text');
  if (pill) pill.textContent = `${who.name} is using this tab`;
}

async function loadModels() {
  const s = await window.assistant.getSettings();
  const select = $('model');
  const groups = new Map();
  for (const m of s.models) {
    if (!groups.has(m.group)) groups.set(m.group, Object.assign(document.createElement('optgroup'), { label: m.group }));
    const option = document.createElement('option');
    option.value = m.id;
    option.textContent = m.label;
    option.title = m.detail;
    groups.get(m.group).append(option);
  }
  // A single group needs no heading.
  select.replaceChildren(...(groups.size > 1 ? groups.values() : [...groups.values()].flatMap((g) => [...g.children])));
  select.value = s.model;
  const current = s.models.find((m) => m.id === s.model);
  select.title = current?.detail || '';
  prompt.placeholder = `Ask ${current && current.group !== 'Claude' ? current.label : 'Claude'}…`;
  setAssistantIdentity(current?.group || 'Claude');
}
window.assistant.onModelsUpdated?.(() => loadModels());
$('model').addEventListener('change', async (e) => {
  const select = e.target;
  await window.assistant.setModel(select.value);
  const label = select.selectedOptions[0].textContent;
  select.title = select.selectedOptions[0].title;
  const group = select.selectedOptions[0].parentElement?.label;
  prompt.placeholder = `Ask ${group && group !== 'Claude' ? select.selectedOptions[0].textContent : 'Claude'}…`;
  setAssistantIdentity(group || 'Claude');
  // The conversation carries over: the next message goes to the new model with the full history.
  if (messages.querySelector('.msg')) {
    append(Object.assign(document.createElement('div'), { className: 'notice', textContent: `Now using ${label}. It can see this whole conversation.` }));
  }
  prompt.focus();
});
loadModels();
function openSettings(visible) {
  const panel = $('settings');
  panel.hidden = !visible;
  if (visible) { refreshSettings(); $('api-key').focus(); }
}
$('open-settings').onclick = () => openSettings($('settings').hidden);
window.browser.onOpenSettings?.(() => { showSidebar(true); openSettings(true); });
$('save-key').onclick = async () => {
  const key = $('api-key').value.trim();
  if (!key) return;
  try {
    await window.assistant.setKey(key);
    $('api-key').value = '';
    $('settings').hidden = true;
  } catch (err) {
    $('key-status').textContent = err.message;
  }
};
$('clear-key').onclick = async () => { await window.assistant.setKey(null); refreshSettings(); };

// ---------- chat ----------

const messages = $('messages');
const prompt = $('prompt');
const send = $('send');
let running = false;
let turn = null; // DOM state for the in-progress assistant reply
let runId = 0; // events from older runs (after Stop or New chat) are ignored

function scrollToBottom() {
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;
  if (nearBottom) messages.scrollTop = messages.scrollHeight;
}

function append(el) {
  $('empty').hidden = true;
  messages.append(el);
  scrollToBottom();
  return el;
}

function setRunning(value) {
  running = value;
  document.body.classList.toggle('agent-active', value);
  reportBounds();
  send.classList.toggle('stop', value);
  send.title = value ? 'Stop' : 'Send (Enter)';
  send.setAttribute('aria-label', value ? 'Stop' : 'Send');
  updateSend();
}

function updateSend() {
  send.disabled = !running && !prompt.value.trim() && attachments.length === 0;
}

// ---------- image attachments: paste or drop images into the sidebar ----------

const MAX_IMAGES = 5;
const MAX_EDGE = 1568; // larger images are downscaled by the API anyway; resizing first saves upload time
const MAX_BYTES = 3.5 * 1024 * 1024;
const PASSTHROUGH = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
let attachments = []; // { media_type, data (base64), url (data URL for previews) }

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

async function toAttachment(file) {
  const url = await readAsDataUrl(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  const edge = Math.max(img.naturalWidth, img.naturalHeight);
  if (PASSTHROUGH.includes(file.type) && edge <= MAX_EDGE && file.size <= MAX_BYTES) {
    return { media_type: file.type, data: url.split(',')[1], url };
  }
  const scale = Math.min(1, MAX_EDGE / edge);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const out = canvas.toDataURL(type, 0.9);
  return { media_type: type, data: out.split(',')[1], url: out };
}

async function addImages(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  for (const file of images) {
    if (attachments.length >= MAX_IMAGES) break;
    try {
      attachments.push(await toAttachment(file));
    } catch {
      // Unreadable image (e.g. an unsupported format); skip it.
    }
  }
  renderAttachments();
  return images.length > 0;
}

function renderAttachments() {
  const strip = $('attachments');
  strip.replaceChildren();
  strip.hidden = attachments.length === 0;
  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attachment';
    const img = document.createElement('img');
    img.src = a.url;
    img.alt = `Attached image ${i + 1}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.setAttribute('aria-label', `Remove image ${i + 1}`);
    remove.innerHTML = '<svg viewBox="0 0 10 10"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>';
    remove.onclick = () => { attachments.splice(i, 1); renderAttachments(); prompt.focus(); };
    chip.append(img, remove);
    strip.append(chip);
  });
  updateSend();
}

prompt.addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.some((f) => f.type.startsWith('image/'))) {
    e.preventDefault(); // text paste stays untouched; only images are intercepted
    await addImages(files);
  }
});
const sidebarEl = $('sidebar');
sidebarEl.addEventListener('dragover', (e) => {
  if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) {
    e.preventDefault();
    sidebarEl.classList.add('dropping');
  }
});
sidebarEl.addEventListener('dragleave', (e) => { if (!sidebarEl.contains(e.relatedTarget)) sidebarEl.classList.remove('dropping'); });
sidebarEl.addEventListener('drop', async (e) => {
  sidebarEl.classList.remove('dropping');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  await addImages(e.dataTransfer.files);
  prompt.focus();
});

function ask(text, images = []) {
  if (running) return;
  const bubble = document.createElement('div');
  bubble.className = 'msg user';
  if (images.length) {
    const row = document.createElement('div');
    row.className = 'msg-images';
    for (const [i, a] of images.entries()) {
      const img = document.createElement('img');
      img.src = a.url;
      img.alt = `Image ${i + 1}`;
      row.append(img);
    }
    bubble.append(row);
  }
  if (text) bubble.append(document.createTextNode(text));
  append(bubble);
  const working = document.createElement('div');
  working.className = 'working';
  working.innerHTML = '<span></span><span></span><span></span>';
  turn = { text: null, textSource: '', thinking: null, working: append(working), steps: new Map() };
  setRunning(true);
  window.assistant.ask(text, ++runId, images.map(({ media_type, data }) => ({ media_type, data })));
}

function moveWorkingToEnd() {
  if (turn?.working) messages.append(turn.working);
}

const TOOL_LABELS = {
  read_page: () => 'Reading page',
  screenshot: () => 'Taking screenshot',
  navigate: (i) => `Opening ${i.url}`,
  click: () => 'Clicking',
  type_text: (i) => `Typing “${i.text}”`,
  press_key: (i) => `Pressing ${i.key}`,
  scroll: (i) => `Scrolling ${i.direction}`,
  go_back: () => 'Going back',
  list_tabs: () => 'Checking tabs',
  open_tab: (i) => `Opening new tab: ${i.url}`,
  switch_tab: (i) => `Switching to tab ${i.tab_id}`,
  wait: (i) => `Waiting ${i.seconds}s`,
  web_search: (i) => `Searching the web: ${i.query ?? ''}`,
};

function endStream() {
  turn?.text?.classList.remove('streaming');
}

window.assistant.onEvent((event) => {
  if (!turn || event.runId !== runId) return;
  switch (event.type) {
    case 'turn_start':
    case 'text_block':
      endStream();
      turn.text = null; // next text starts a fresh block after any tool steps
      turn.textSource = '';
      turn.thinking = null;
      break;
    case 'thinking': {
      if (!turn.thinking) {
        const details = document.createElement('details');
        details.className = 'thinking';
        details.innerHTML = '<summary>Thinking</summary><div></div>';
        turn.thinking = append(details).querySelector('div');
      }
      turn.thinking.textContent += event.text;
      moveWorkingToEnd();
      break;
    }
    case 'text': {
      if (!turn.text) turn.text = append(Object.assign(document.createElement('div'), { className: 'msg assistant streaming' }));
      turn.textSource += event.text;
      turn.text.innerHTML = window.renderMarkdown(settledMarkdown(turn.textSource));
      moveWorkingToEnd();
      scrollToBottom();
      break;
    }
    case 'tool': {
      finishReply(turn.text, turn.textSource);
      const label = event.label || (TOOL_LABELS[event.name] || (() => event.name))(event.input || {});
      const step = document.createElement('div');
      step.className = event.id ? 'step running' : 'step done';
      if (event.id) turn.steps.set(event.id, step);
      step.innerHTML = '<span class="step-detail"></span>';
      step.firstChild.textContent = label;
      step.title = label;
      append(step);
      endStream();
      turn.text = null;
      turn.textSource = '';
      moveWorkingToEnd();
      break;
    }
    case 'tool_done': {
      const step = turn.steps.get(event.id);
      if (!step) break;
      step.className = event.ok ? 'step done' : event.stopped ? 'step stopped' : 'step failed';
      if (!event.ok && event.error) {
        const lines = String(event.error).split('\n').map((l) => l.trim()).filter(Boolean);
        const reason = lines.find((l) => /failed/i.test(l) && !/^\d+ of \d+ fields failed:?$/i.test(l)) || lines[0] || '';
        const why = document.createElement('span');
        why.className = 'step-error';
        why.textContent = reason;
        why.title = lines.join('\n');
        step.append(why);
      }
      break;
    }
    case 'approval':
      showApproval(event.approvalId, event.host);
      moveWorkingToEnd();
      break;
    case 'approval_done':
      resolveApproval(event.approvalId, event.ok);
      break;
    case 'notice':
      append(Object.assign(document.createElement('div'), { className: 'notice', textContent: event.text }));
      break;
    case 'error': {
      const error = append(Object.assign(document.createElement('div'), { className: 'error', textContent: event.text }));
      if (event.action === 'settings') {
        const button = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Add API key' });
        button.onclick = () => openSettings(true);
        error.append(button);
      }
      break;
    }
    case 'done':
      finishReply(turn.text, turn.textSource);
      labelReply(turn.text, event.model);
      endStream();
      for (const step of turn.steps.values()) if (step.classList.contains('running')) step.className = 'step stopped';
      turn.working.remove();
      turn = null;
      setRunning(false);
      break;
  }
});

// While a reply streams, hold back a trailing link that hasn't finished arriving
// ("[text](https://…" with no closing parenthesis yet), so raw markdown never flashes.
function settledMarkdown(source) {
  const open = source.lastIndexOf('[');
  if (open === -1) return source;
  const tail = source.slice(open);
  if (/^\[[^\]\n]*$/.test(tail) || /^\[[^\]\n]*\]\([^)\s]*$/.test(tail)) return source.slice(0, open);
  return source;
}

// Which model wrote a reply: a quiet label, since a chat can move between models.
function labelReply(bubble, modelId) {
  if (!bubble || !modelId || bubble.querySelector('.reply-model')) return;
  const option = [...$('model').options].find((o) => o.value === modelId);
  const group = option?.parentElement?.label;
  const name = option ? (group && group !== 'Claude' ? `${group} · ${option.textContent}` : `Claude ${option.textContent}`) : modelId;
  bubble.append(Object.assign(document.createElement('span'), { className: 'reply-model', textContent: name }));
}

// ---------- copy a reply ----------

const COPY_ICON = '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v.5"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>';

function finishReply(bubble, source) {
  if (!bubble || !source || !source.trim() || bubble.querySelector('.reply-copy')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reply-copy';
  button.title = 'Copy reply';
  button.setAttribute('aria-label', 'Copy reply');
  button.innerHTML = COPY_ICON;
  button.onclick = async () => {
    try {
      const html = window.renderMarkdown(source);
      const text = bubble.innerText.trim() || source;
      if (window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      button.innerHTML = CHECK_ICON;
      button.classList.add('copied');
      setTimeout(() => { button.innerHTML = COPY_ICON; button.classList.remove('copied'); }, 1400);
    } catch {
      button.title = 'Could not copy';
    }
  };
  bubble.append(button);
}

// ---------- inline approval before Claude acts on a new site ----------

const approvals = new Map(); // approvalId -> { card, host }

function showApproval(approvalId, host) {
  const card = document.createElement('div');
  card.className = 'approval';
  card.tabIndex = 0;
  card.setAttribute('role', 'group');
  const agentName = assistantIdentity?.name || 'the AI';
  card.setAttribute('aria-label', `Allow ${agentName} to interact with ${host}?`);

  const title = document.createElement('p');
  title.className = 'approval-title';
  title.textContent = `Allow ${agentName} to interact with ${host}?`;
  const detail = document.createElement('p');
  detail.className = 'approval-detail';
  detail.textContent = 'It can click, type and fill in forms on this site until you start a new chat.';

  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const deny = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: "Don't allow" });
  const allow = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: 'Allow for this chat' });
  const answer = (ok) => {
    if (card.classList.contains('answered')) return;
    card.classList.add('answered');
    deny.disabled = true;
    allow.disabled = true;
    window.assistant.approve?.(approvalId, ok);
  };
  deny.onclick = () => answer(false);
  allow.onclick = () => answer(true);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === card) { e.preventDefault(); answer(true); }
    else if (e.key === 'Escape') { e.preventDefault(); answer(false); }
  });

  actions.append(deny, allow);
  card.append(title, detail, actions);
  append(card);
  approvals.set(approvalId, { card, host });
  card.focus({ preventScroll: true });
  scrollToBottom();
}

function resolveApproval(approvalId, ok) {
  const entry = approvals.get(approvalId);
  if (!entry) return;
  approvals.delete(approvalId);
  const { card, host } = entry;
  card.className = ok ? 'approval resolved' : 'approval resolved denied';
  card.removeAttribute('tabindex');
  card.removeAttribute('role');
  card.removeAttribute('aria-label');
  card.textContent = ok ? `Allowed on ${host}` : `Not allowed on ${host}`;
  if (document.activeElement === document.body) prompt.focus();
}

// ---------- chat restored from the last session ----------

window.assistant.onHistory?.(({ items } = {}) => {
  if (!Array.isArray(items) || !items.length || messages.querySelector('.msg')) return;
  for (const item of items) {
    const bubble = document.createElement('div');
    if (item.role === 'user') {
      bubble.className = 'msg user';
      const images = (item.images || []).filter((src) => typeof src === 'string' && src.startsWith('data:image/'));
      if (images.length) {
        const row = document.createElement('div');
        row.className = 'msg-images';
        images.forEach((src, i) => row.append(Object.assign(document.createElement('img'), { src, alt: `Image ${i + 1}` })));
        bubble.append(row);
      }
      if (item.text) bubble.append(document.createTextNode(item.text));
    } else if (item.role === 'assistant' && item.text) {
      if (item.steps) {
        const summary = document.createElement('div');
        summary.className = 'step done restored';
        summary.innerHTML = '<span class="step-detail"></span>';
        summary.firstChild.textContent = `Used ${item.steps} browser action${item.steps === 1 ? '' : 's'}`;
        append(summary);
      }
      bubble.className = 'msg assistant';
      bubble.innerHTML = window.renderMarkdown(item.text);
      finishReply(bubble, item.text);
    } else {
      continue;
    }
    bubble.classList.add('restored');
    append(bubble);
  }
  messages.scrollTop = messages.scrollHeight;
});

// ---------- downloads indicator ----------

const downloadsBtn = $('downloads');
const RING = 2 * Math.PI * 10;
let downloadStates = new Map();
let pulseTimer = null;

window.browser.onDownloads?.((list) => {
  if (!Array.isArray(list) || !list.length) return;
  downloadsBtn.hidden = false;
  const active = list.filter((d) => d.state === 'progressing');
  const sized = active.filter((d) => d.total > 0);
  const total = sized.reduce((s, d) => s + d.total, 0);
  const received = sized.reduce((s, d) => s + Math.min(d.received, d.total), 0);
  downloadsBtn.classList.toggle('progressing', active.length > 0);
  const fraction = total ? received / total : 0.08; // unknown size: a sliver, so the ring still reads as "working"
  downloadsBtn.querySelector('.ring-bar').style.strokeDashoffset = String(RING * (1 - fraction));

  const justFinished = list.some((d) => d.state === 'completed' && downloadStates.get(d.id) === 'progressing');
  downloadStates = new Map(list.map((d) => [d.id, d.state]));
  if (justFinished) {
    downloadsBtn.classList.remove('finished');
    void downloadsBtn.offsetWidth; // restart the animation
    downloadsBtn.classList.add('finished');
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => downloadsBtn.classList.remove('finished'), 2000);
  }

  const latest = list[0];
  const status = latest.state === 'progressing'
    ? (latest.total ? `${Math.round((latest.received / latest.total) * 100)}%` : 'downloading')
    : latest.state === 'completed' ? 'done' : latest.state;
  downloadsBtn.title = `${latest.name} — ${status}`;
});
downloadsBtn.onclick = () => {
  const r = downloadsBtn.getBoundingClientRect();
  window.browser.openDownloadsMenu?.({ x: Math.round(r.left), y: Math.round(r.bottom) });
};

// Links in replies open in a new tab.
messages.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (!link) return;
  e.preventDefault();
  window.browser.newTab(link.href);
});

new ResizeObserver(() => {
  $('sidebar').style.setProperty('--composer-h', `${$('composer').offsetHeight}px`);
}).observe($('composer'));

function autosize() {
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(prompt.scrollHeight, 160)}px`;
}
prompt.addEventListener('input', () => { autosize(); updateSend(); });
prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (running) { window.assistant.stop(); return; }
  const text = prompt.value.trim();
  if (!text && attachments.length === 0) return;
  const images = attachments;
  attachments = [];
  renderAttachments();
  prompt.value = '';
  autosize();
  ask(text, images);
  updateSend();
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.onclick = () => ask(chip.dataset.prompt);
});

$('new-chat').onclick = () => {
  window.assistant.reset();
  runId++;
  approvals.clear();
  messages.querySelectorAll(':scope > :not(#empty)').forEach((el) => el.remove());
  $('empty').hidden = false;
  turn = null;
  setRunning(false);
  prompt.focus();
};

// Pause decorative loops (agent glow, pill light) while the window is in the background.
window.browser.onWindowFocus?.((focused) => document.body.classList.toggle('window-inactive', !focused));

// ---------- AI agents over MCP (session B) ----------
// External agents (Claude Code, Codex, Gemini CLI…) drive the browser; their calls show here.

const mcpSteps = new Map(); // step id -> row
let mcpPillText = null;

function mcpStepRow(event) {
  const label = event.label || (TOOL_LABELS[event.name] || (() => event.name))(event.input || {});
  const step = document.createElement('div');
  step.className = 'step running mcp-step';
  step.innerHTML = '<span class="step-detail"></span>';
  step.firstChild.textContent = `${event.clientName}: ${label}`;
  step.title = step.firstChild.textContent;
  mcpSteps.set(event.id, step);
  append(step);
}

window.assistant.onMcpEvent?.((event) => {
  switch (event.type) {
    case 'session': {
      document.body.classList.toggle('mcp-active', event.active || event.remaining > 0);
      const text = document.querySelector('#agent-pill span:not(.agent-dot)');
      if (text) {
        if (mcpPillText === null) mcpPillText = text.textContent;
        text.textContent = event.active || event.remaining > 0 ? `Lumen is being driven by ${event.clientName}` : mcpPillText;
      }
      append(Object.assign(document.createElement('div'), { className: 'notice', textContent: event.active ? `${event.clientName} connected to Lumen.` : `${event.clientName} disconnected.` }));
      break;
    }
    case 'tool':
      mcpStepRow(event);
      break;
    case 'tool_done': {
      const step = mcpSteps.get(event.id);
      if (!step) break;
      step.className = `step mcp-step ${event.ok ? 'done' : 'failed'}`;
      if (!event.ok && event.error) step.append(Object.assign(document.createElement('span'), { className: 'step-error', textContent: event.error }));
      mcpSteps.delete(event.id);
      break;
    }
    case 'approval': {
      showSidebar(true);
      showApproval(event.approvalId, event.host);
      const card = approvals.get(event.approvalId)?.card;
      const title = card?.querySelector('.approval-title');
      if (title) title.textContent = `An external agent (${event.clientName}) wants to interact with ${event.host}`;
      card?.setAttribute('aria-label', title?.textContent || '');
      break;
    }
    case 'approval_done':
      resolveApproval(event.approvalId, event.ok);
      break;
  }
});

// Stop on the pill ends external sessions when the sidebar agent isn't running.
$('agent-stop')?.addEventListener('click', () => {
  if (document.body.classList.contains('mcp-active') && !running) window.assistant.stopMcp?.();
});

async function renderMcpSettings() {
  const info = await window.assistant.mcpInfo?.();
  if (!info) return;
  $('mcp-enabled').checked = info.enabled;
  const box = $('mcp-snippets');
  box.replaceChildren();
  for (const s of info.snippets) {
    const row = document.createElement('div');
    row.className = 'mcp-snippet';
    const head = document.createElement('div');
    head.className = 'mcp-snippet-head';
    head.append(
      Object.assign(document.createElement('span'), { className: 'toggle-title', textContent: s.label }),
      Object.assign(document.createElement('span'), { className: 'hint', textContent: s.hint }),
    );
    const code = Object.assign(document.createElement('pre'), { className: 'mcp-code', textContent: s.text });
    const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Copy' });
    copy.onclick = async () => {
      await navigator.clipboard.writeText(s.text).catch(() => {});
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
    };
    head.append(copy);
    // ---- [claude code engine] One click: main runs `claude mcp get/add` with an argv array (no shell).
    let addStatus = null;
    if (s.addButton && window.lumenExtras?.addToClaudeCode) {
      const add = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: 'Add to Claude Code' });
      const status = Object.assign(document.createElement('p'), { className: 'hint mcp-add-status', hidden: true });
      add.onclick = async () => {
        add.disabled = true;
        add.textContent = 'Adding…';
        const r = await window.lumenExtras.addToClaudeCode().catch((err) => ({ ok: false, text: err.message }));
        add.textContent = r.already ? 'Already connected' : r.ok ? 'Added' : 'Add to Claude Code';
        add.disabled = Boolean(r.ok);
        status.hidden = Boolean(r.already);
        status.textContent = r.already ? '' : r.text;
      };
      head.append(add);
      addStatus = status;
    }
    // ---- [/claude code engine]
    row.append(head, code);
    if (addStatus) row.append(addStatus); // [claude code engine]
    box.append(row);
  }
}
$('mcp-enabled')?.addEventListener('change', (e) => window.assistant.setMcpEnabled?.(e.target.checked));
$('mcp-section')?.addEventListener('toggle', (e) => { if (e.target.open) renderMcpSettings(); });
renderMcpSettings();
