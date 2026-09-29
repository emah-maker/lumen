// ($ and the chat itself live in chat-core.js, loaded before this file.)

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
  // The page area's width with the sidebar closed: the new-tab page keeps laying itself out at this
  // width while the sidebar covers its right side (main.js layout(), features/sidebar-overlay.js).
  bounds.fullWidth = Math.max(bounds.width, Math.round(document.querySelector('.body').getBoundingClientRect().right - r.left - inset * 2));
  const key = `${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)},${Math.round(bounds.fullWidth)}`;
  if (key === lastBounds) return; // called every frame during animations; only send changes
  lastBounds = key;
  window.browser.setContentBounds(bounds);
}
new ResizeObserver(reportBounds).observe(viewport);
window.addEventListener('resize', reportBounds);

// ---------- motion ----------

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
// The system setting, or Settings → Accessibility → Reduce motion (the pref-reduce-motion class):
// the springs and FLIP animations run in JS, so the CSS rule alone didn't stop them.
const motionReduced = () => reduceMotion.matches || document.documentElement.classList.contains('pref-reduce-motion');
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
let currentSecurity = null; // 'broken' (past a certificate warning) | 'mixed' (http content loaded) | null
let currentLumenPage = false; // Reader mode / View Source: Lumen's own page for a web address
let lastActiveId = null;

const GLOBE = '<path d="M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5ZM1.75 8h12.5M8 1.75c1.7 1.8 2.5 3.9 2.5 6.25S9.7 12.45 8 14.25C6.3 12.45 5.5 10.35 5.5 8S6.3 3.55 8 1.75Z"/>';
const LOCK = '<svg viewBox="0 0 12 12"><rect x="2.5" y="5.25" width="7" height="5" rx="1"/><path d="M4 5.25V4a2 2 0 0 1 4 0v1.25"/></svg>';
const WARN = '<svg viewBox="0 0 12 12"><path d="M6 1.5 11 10.5H1Z"/><path d="M6 5v2.25M6 8.75v.01"/></svg>';

// Lumen's own pages: a gear for Settings, a clock for History.
const PAGE_ICONS = {
  settings: '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.75v1.6M8 12.65v1.6M1.75 8h1.6M12.65 8h1.6M3.58 3.58l1.13 1.13M11.29 11.29l1.13 1.13M3.58 12.42l1.13-1.13M11.29 4.71l1.13-1.13"/><circle cx="8" cy="8" r="4.4"/>',
  history: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.5V8l2.25 1.5"/>',
  reader: '<path d="M2.5 3.5h4.25A1.25 1.25 0 0 1 8 4.75v8a1.25 1.25 0 0 0-1.25-1.25H2.5Zm11 0H9.25A1.25 1.25 0 0 0 8 4.75v8a1.25 1.25 0 0 1 1.25-1.25h4.25Z"/>',
  source: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
  bookmarks: '<path d="M4.25 2.25h7.5v11.5L8 11l-3.75 2.75z"/>',
  downloads: '<path d="M8 2.25v8M4.75 7.25 8 10.5l3.25-3.25M3 13.25h10"/>',
  chat: '<path d="M3.25 3.25h9.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H8L5 13.25v-2.5H3.25a1 1 0 0 1-1-1v-5.5a1 1 0 0 1 1-1Z"/>',
};

function globeIcon(page = null) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `tab-favicon globe${PAGE_ICONS[page] ? ' page-icon' : ''}`);
  svg.innerHTML = PAGE_ICONS[page] || GLOBE;
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
  if (currentError || currentLumenPage) {
    security.hidden = true; // an error page (or Lumen's own reader/source page) has no connection to vouch for
  } else if (currentUrl.startsWith('https:') && currentSecurity === 'broken') {
    security.className = 'security danger';
    security.innerHTML = WARN + '<span>Not secure</span>';
    security.title = "This site's certificate isn't trusted. You chose to continue anyway.";
    security.hidden = false;
  } else if (currentUrl.startsWith('https:') && currentSecurity === 'mixed') {
    security.className = 'security insecure';
    security.innerHTML = WARN;
    security.title = 'Not fully secure: parts of this page (such as images) were loaded over an unencrypted connection';
    security.hidden = false;
  } else if (currentUrl.startsWith('https:')) {
    security.className = 'security';
    security.innerHTML = LOCK;
    security.title = t('security.secure');
    security.hidden = false;
  } else if (currentUrl.startsWith('http:')) {
    security.className = 'security insecure';
    security.innerHTML = WARN;
    security.append(Object.assign(document.createElement('span'), { textContent: t('security.notSecure') }));
    security.title = t('security.notEncrypted');
    security.hidden = false;
  } else {
    security.hidden = true;
  }
}

// ---------- tab reordering (pointer drag) ----------

let drag = null; // { el, id, startX, dx, moved, rects, from, to }
let pendingState = null; // tab updates that arrive mid-drag are applied on release
let suppressClick = false;
// A multi-selection (Shift+click, Ctrl/Cmd+click, as in Chrome): the tab ids in it, the active tab
// among them. Empty means only the active tab is selected. See "multi-select" below.
let selectedTabs = new Set();

function startTabDrag(e, el, id) {
  if (e.button !== 0 || e.target.closest('.tab-close, .tab-audio')) return;
  const tabs = [...$('tabs').querySelectorAll('.tab')];
  drag = { el, id, startX: e.clientX, dx: 0, moved: false, ids: tabs.map((t) => Number(t.dataset.id)), rects: tabs.map((t) => t.getBoundingClientRect()), from: tabs.indexOf(el) };
  drag.to = drag.from;
  el.setPointerCapture(e.pointerId);
  // Once the tab has left for a window of its own this page may lose the pointer, so the release and
  // Escape are also watched on the window (main.js has its own fallbacks: see "dragging a tab out").
  window.addEventListener('pointerup', endTabDrag, true);
  window.addEventListener('pointercancel', endTabDrag, true);
  window.addEventListener('keydown', dragKey, true);
}
function dragKey(e) {
  if (e.key === 'Escape' && drag) { e.preventDefault(); e.stopPropagation(); endTabDrag(e); }
}
// This window is the one being dragged (its tab arrived from elsewhere): report the release from here.
window.browser.onTabDragWatch?.(() => {
  const up = () => { window.removeEventListener('pointerup', up, true); window.removeEventListener('mouseup', up, true); window.browser.dragTabEnd?.(); };
  window.addEventListener('pointerup', up, true);
  window.addEventListener('mouseup', up, true);
});
// Another window's tab is being dragged over this strip: mark where it would land.
window.browser.onTabDropAt?.((at) => {
  $('tabs').querySelectorAll('.drop-before, .drop-end').forEach((t) => t.classList.remove('drop-before', 'drop-end'));
  if (!at) return;
  const strip = [...$('tabs').querySelectorAll('.tab')];
  const before = strip.find((t) => Number(t.dataset.id) === at.beforeId);
  if (before) before.classList.add('drop-before');
  else strip[strip.length - 1]?.classList.add('drop-end');
});

// Dragged this far outside the strip (or out of the window), releasing the tab hands it to main.js:
// into another window's strip if the cursor is over one, else into a new window of its own.
const TEAR_OFF_PX = 36;
function draggedOut(e) {
  const bar = $('tabs').getBoundingClientRect();
  return e.clientY > bar.bottom + TEAR_OFF_PX || e.clientY < bar.top - TEAR_OFF_PX
    || e.clientX < -TEAR_OFF_PX / 2 || e.clientX > window.innerWidth + TEAR_OFF_PX / 2;
}

// Past the threshold the tab goes to main.js, which moves it into a new window under the cursor (or
// drags this whole window if it is the only tab). The element stays (holding the pointer) but takes no room.
function handOffTabDrag(e) {
  const r = drag.rects[drag.from];
  drag.handed = true;
  drag.el.style.transform = '';
  [...$('tabs').querySelectorAll('.tab')].forEach((t) => { t.style.transform = ''; });
  drag.el.classList.remove('tearing');
  drag.el.classList.add('handed');
  window.browser.dragTabStart?.(drag.id, { x: e.clientX, y: e.clientY, stripX: drag.rects[0].left + (drag.startX - r.left) });
}

function moveTabDrag(e) {
  if (!drag || drag.handed) return;
  drag.dx = e.clientX - drag.startX;
  if (!drag.moved && Math.abs(drag.dx) < 5) return;
  if (!drag.moved) {
    drag.moved = true;
    hideHoverCard();
    drag.el.classList.add('dragging');
    $('tabs').classList.add('reordering');
  }
  const { rects, from } = drag;
  const first = rects[0].left, last = rects[rects.length - 1].right;
  const dx = Math.max(first - rects[from].left, Math.min(last - rects[from].right, drag.dx));
  drag.el.style.transform = `translateX(${dx}px)`;
  if (window.browser.dragTabStart && draggedOut(e)) { handOffTabDrag(e); return; }
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

function endTabDrag(e) {
  if (!drag) return;
  const { moved, from, to, id, ids, handed } = drag;
  const escaped = e?.type === 'keydown'; // a cancelled pointer just ends the drag where it is
  drag = null;
  window.removeEventListener('pointerup', endTabDrag, true);
  window.removeEventListener('pointercancel', endTabDrag, true);
  window.removeEventListener('keydown', dragKey, true);
  $('tabs').classList.remove('reordering');
  [...$('tabs').children].forEach((t) => { t.style.transform = ''; t.classList.remove('dragging', 'tearing', 'handed'); });
  if (moved) {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (handed) {
      if (escaped) window.browser.dragTabCancel?.(); else window.browser.dragTabEnd?.();
    } else if (e?.type === 'keydown') {
      // Escape before the tab left the strip: it stays where it was.
    } else if (from !== to) {
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
  const animate = tabsRendered && !motionReduced();
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

// A group's label in the strip: made once per group, then updated in place (`label`).
function groupLabel(group, count, crowded, label = null) {
  if (!label) {
    label = document.createElement('button');
    label.type = 'button';
    label.setAttribute('role', 'tab'); // a tablist holds only tabs; Enter/Space still toggle the group
    label.setAttribute('aria-selected', 'false');
    label.dataset.id = `g${group.id}`;
    label.dataset.group = String(group.id);
    const name = Object.assign(document.createElement('span'), { className: 'group-name' });
    const badge = Object.assign(document.createElement('span'), { className: 'group-count' });
    label.append(name, badge);
    label.onclick = () => window.browser.toggleGroup(group.id);
    label.oncontextmenu = (e) => { e.preventDefault(); window.browser.groupMenu(group.id, { x: e.clientX, y: e.clientY }); };
  }
  label.className = 'group-label' + (group.collapsed ? ' collapsed' : '') + (crowded ? ' crowded' : '');
  label.style.setProperty('--group-color', `var(--g-${group.color})`);
  label.setAttribute('aria-expanded', String(!group.collapsed));
  label.setAttribute('aria-label', t(count === 1 ? 'tabs.group.label.one' : 'tabs.group.label.other', { name: group.name, count }));
  label.title = t(group.collapsed ? 'tabs.group.title.expand' : 'tabs.group.title.collapse', { name: group.name });
  label.querySelector('.group-name').textContent = group.name;
  label.querySelector('.group-count').textContent = String(count);
  return label;
}

// A tab in the strip: made once per tab id (handlers only need the id), then updated in place.
function createTabEl(id) {
  const el = document.createElement('div');
  el.dataset.id = String(id);
  el.setAttribute('role', 'tab');
  const inner = Object.assign(document.createElement('div'), { className: 'tab-inner' });
  const title = Object.assign(document.createElement('span'), { className: 'tab-title' });
  const close = Object.assign(document.createElement('button'), { className: 'tab-close' });
  close.innerHTML = '<svg viewBox="0 0 10 10"><path d="M2 2l6 6M8 2 2 8"/></svg>';
  close.tabIndex = -1; // a tab's parts aren't separate stops: Delete closes it (see the strip keyboard below)
  close.setAttribute('aria-hidden', 'true');
  // The press decides: a press on ✕ closes the tab when it's released anywhere on the tab. The
  // strip can slide under a held button (a tab closing or opening next to it), which moved the
  // release onto the title, and the click then went to the tab instead of the ✕.
  let closePressed = false;
  let closedByPress = false;
  el.addEventListener('pointerdown', (e) => { closePressed = e.button === 0 && Boolean(e.target.closest('.tab-close')); });
  el.addEventListener('pointerup', (e) => {
    if (!closePressed || e.button !== 0) return;
    closePressed = false;
    closedByPress = true; // the click that follows is this close, not a tab switch
    setTimeout(() => { closedByPress = false; }, 0);
    holdTabWidths();
    window.browser.closeTab(id);
  });
  el.addEventListener('pointerleave', () => { closePressed = false; });
  close.onclick = (e) => { e.stopPropagation(); if (e.detail === 0) window.browser.closeTab(id); }; // detail 0: Enter/Space
  inner.append(globeIcon(), title, close);
  el.append(inner);
  el.onclick = (e) => { if (!suppressClick && !closedByPress) clickTab(e, id); };
  // A middle press would otherwise start Chromium's autoscroll, which swallows the auxclick.
  el.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); };
  el.onauxclick = (e) => { if (e.button === 1) { holdTabWidths(); window.browser.closeTab(id); } };
  el.oncontextmenu = (e) => { e.preventDefault(); window.browser.tabMenu(id, { x: e.clientX, y: e.clientY }); };
  el.addEventListener('pointerdown', (e) => startTabDrag(e, el, id));
  el.addEventListener('pointermove', moveTabDrag);
  el.addEventListener('pointerup', endTabDrag);
  el.addEventListener('pointercancel', endTabDrag);
  return el;
}

// A tab's favicon: the page's candidates in turn, falling through to the next when one doesn't load
// (a page may list a missing icon next to a good one). When none loads, the globe stands in and the
// icons are tried once more a little later, since a failure may be a passing one (a server error,
// the network dropping for a moment); an <img> that failed would otherwise stay a globe for good.
const FAVICON_RETRY_MS = 3000;
function faviconImg(el, key, urls, retried = false) {
  const img = document.createElement('img');
  img.className = 'tab-favicon';
  let i = 0;
  img.onerror = () => {
    if (++i < urls.length) { img.src = urls[i]; return; }
    const globe = globeIcon();
    img.replaceWith(globe);
    if (retried) return;
    setTimeout(() => {
      // Only if the tab still wants these icons and still shows the globe that replaced them.
      if (el.dataset.icon !== key || !globe.isConnected) return;
      const again = faviconImg(el, key, urls, true);
      // Swapped in only once it has loaded, so a second failure doesn't flash an empty image.
      again.addEventListener('load', () => { if (el.dataset.icon === key && globe.isConnected) globe.replaceWith(again); }, { once: true });
    }, FAVICON_RETRY_MS);
  };
  img.src = urls[0];
  return img;
}

function updateTabEl(el, tab, group, activeId) {
  const active = tab.id === activeId;
  el.className = 'tab' + (active ? ' active' : '') + (group ? ' grouped' : '') + (tab.sleeping ? ' sleeping' : '') + (tab.pinned ? ' pinned' : '') + (tab.alert ? ' alert' : '') + (tab.aiReading ? ' ai-reading' : '')
    + (selectedTabs.has(tab.id) && !active ? ' selected' : '');
  if (group) el.style.setProperty('--group-color', `var(--g-${group.color})`);
  else el.style.removeProperty('--group-color');
  el.setAttribute('aria-selected', String(active));
  // No title tooltip: the hover card (below) shows the title, as in Chrome, and the two would overlap.
  el.setAttribute('aria-label', tab.aiReading ? `${tab.title} (AI is reading)` : tab.title);
  // The icon is only swapped when it changes: a new <img> on every update restarted its fade-in.
  const favicons = tab.favicons?.length ? tab.favicons : tab.favicon ? [tab.favicon] : [];
  const iconKey = tab.loading || tab.aiReading ? 'loading' : favicons.length && !tab.error ? `img:${favicons.join(' ')}` : `page:${tab.page || ''}`;
  if (el.dataset.icon !== iconKey) {
    el.dataset.icon = iconKey;
    let icon;
    if (tab.loading || tab.aiReading) {
      icon = document.createElement('span');
      icon.className = 'tab-favicon spinner';
    } else if (favicons.length && !tab.error) {
      icon = faviconImg(el, iconKey, favicons);
    } else {
      icon = globeIcon(tab.page);
    }
    el.querySelector('.tab-favicon').replaceWith(icon);
  }
  const title = el.querySelector('.tab-title');
  if (title.textContent !== tab.title) title.textContent = tab.title;
  el.querySelector('.tab-close').setAttribute('aria-label', t('tabs.close', { title: tab.title }));
  if (typeof updateTabAudio === 'function') updateTabAudio(el, tab); // tab-search.js: the speaker button
  return el;
}

// A press anywhere on the strip (a tab, its ✕, a middle-click, a group label) holds tab updates
// until it's released and its click has landed, the same way a drag does.
let stripPressed = false;
let stripPressTimer = 0;
function releaseStrip() {
  if (!stripPressed) return;
  clearTimeout(stripPressTimer);
  setTimeout(() => { // after the click that follows pointerup
    stripPressed = false;
    if (pendingState && !drag && renamingGroup === null) {
      const held = pendingState;
      pendingState = null;
      renderTabs(held);
    }
  }, 0);
}
$('tabs').addEventListener('pointerdown', () => {
  stripPressed = true;
  clearTimeout(stripPressTimer);
  stripPressTimer = setTimeout(releaseStrip, 4000); // a release that never arrives can't freeze the strip
}, true);
window.addEventListener('pointerup', releaseStrip, true);
window.addEventListener('pointercancel', releaseStrip, true);
window.addEventListener('blur', releaseStrip);

// Tabs past the strip's width: its scrollbar is hidden, so a mouse wheel scrolls it sideways, and
// a fade at either edge shows there is more that way.
function updateOverflow() {
  const strip = $('tabs');
  const max = strip.scrollWidth - strip.clientWidth;
  strip.classList.toggle('more-left', max > 1 && strip.scrollLeft > 1);
  strip.classList.toggle('more-right', max > 1 && strip.scrollLeft < max - 1);
}
$('tabs').addEventListener('scroll', updateOverflow, { passive: true });
$('tabs').addEventListener('wheel', (e) => {
  const strip = $('tabs');
  if (strip.scrollWidth <= strip.clientWidth) return;
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!delta) return;
  e.preventDefault();
  strip.scrollLeft += e.deltaMode === 1 ? delta * 40 : delta; // line-based wheels report lines, not pixels
}, { passive: false });
new ResizeObserver(updateOverflow).observe($('tabs'));

function startRename(groupId) {
  const label = $('tabs').querySelector(`.group-label[data-group="${groupId}"]`);
  const group = lastTabState?.groups?.find((g) => g.id === groupId);
  if (!label || !group) return;
  renamingGroup = groupId;
  const input = Object.assign(document.createElement('input'), { value: group.name, maxLength: 40 });
  input.setAttribute('aria-label', t('tabs.group.name'));
  label.querySelector('.group-name').replaceWith(input);
  label.onclick = null;
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    renamingGroup = null;
    const name = save && input.value.trim() ? input.value.trim() : group.name;
    window.browser.renameGroup(groupId, name);
    // The label is kept across updates now, so it gets its name and click back here.
    input.replaceWith(Object.assign(document.createElement('span'), { className: 'group-name', textContent: name }));
    label.onclick = () => window.browser.toggleGroup(groupId);
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

// ---------- tab strip keyboard (the WAI-ARIA tabs pattern) ----------
// The strip is one stop in the Tab order: the tab you last moved to there, else the active tab
// (roving tabindex). Left/Right/Home/End move between tabs and group labels, Enter or Space opens
// the tab, Delete closes it; Ctrl+Shift+PageUp/PageDown (main.js) moves the active tab. Focus only
// moves here: opening a tab stays a separate, deliberate key, as the pattern's manual activation.

let stripFocusId = null; // data-id of the tab or group label keyboard focus is on, while it's in the strip

const stripItems = () => [...$('tabs').querySelectorAll('.tab:not(.tab-ghost), .group-label')];

function syncTabStripKeyboard() {
  const items = stripItems();
  const current = items.find((el) => el.dataset.id === stripFocusId) || items.find((el) => el.classList.contains('active')) || items[0];
  for (const el of items) el.tabIndex = el === current ? 0 : -1;
  for (const close of $('tabs').querySelectorAll('.tab-close')) close.tabIndex = -1; // Delete closes; one stop per tab
  // A tab moved while focused (Ctrl+Shift+PageUp, a reorder) is re-inserted, which drops focus.
  if (stripFocusId !== null && current && document.activeElement === document.body) current.focus({ preventScroll: true });
}

function focusStripItem(el) {
  if (!el) return;
  stripFocusId = el.dataset.id;
  syncTabStripKeyboard();
  el.focus();
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

$('tabs').addEventListener('focusin', (e) => {
  const el = e.target.closest('.tab, .group-label');
  if (!el) return;
  stripFocusId = el.dataset.id;
  syncTabStripKeyboard();
});
$('tabs').addEventListener('focusout', (e) => {
  if ($('tabs').contains(e.relatedTarget)) return;
  // Leaving for good (not a re-insert, which blurs to <body> for a moment): back to the active tab.
  setTimeout(() => {
    if ($('tabs').contains(document.activeElement) || document.activeElement === document.body) return;
    stripFocusId = null;
    syncTabStripKeyboard();
  });
});
$('tabs').addEventListener('keydown', (e) => {
  const el = e.target.closest?.('.tab, .group-label');
  if (!el || e.target.tagName === 'INPUT' || e.altKey || e.ctrlKey || e.metaKey) return;
  const items = stripItems();
  const i = items.indexOf(el);
  const isTab = el.classList.contains('tab');
  const id = Number(el.dataset.id);
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') focusStripItem(items[(i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]);
  else if (e.key === 'Home') focusStripItem(items[0]);
  else if (e.key === 'End') focusStripItem(items[items.length - 1]);
  else if (isTab && (e.key === 'Enter' || e.key === ' ')) window.browser.switchTab(id);
  else if (isTab && e.key === 'Delete') {
    const next = items[i + 1] || items[i - 1];
    if (next) focusStripItem(next);
    window.browser.closeTab(id);
  } else return;
  e.preventDefault();
});

// ---------- multi-select (Chrome) ----------
// Shift+click selects the run of tabs from the anchor (the tab last clicked, else the active tab) to
// the clicked one; Ctrl+click (Cmd+click on macOS) adds a tab to the selection or takes it out. The
// clicked tab becomes the active one, as in Chrome, and a plain click (or switching tabs any other
// way, to a tab outside the selection) ends it. Main hears the selection (setTabSelection) so the
// tab menu and Ctrl+W can act on all of it; until it listens, the selection is only shown.

let selectionAnchor = null;
const isMac = navigator.platform.startsWith('Mac');
const stripOrder = () => [...$('tabs').querySelectorAll('.tab:not(.tab-ghost)')].map((el) => Number(el.dataset.id));

function setSelection(ids) {
  const next = new Set(ids.length > 1 ? ids : []);
  if (next.size === selectedTabs.size && [...next].every((id) => selectedTabs.has(id))) return;
  selectedTabs = next;
  const activeId = lastTabState?.activeId;
  for (const el of $('tabs').querySelectorAll('.tab:not(.tab-ghost)')) {
    const id = Number(el.dataset.id);
    el.classList.toggle('selected', selectedTabs.has(id) && id !== activeId);
  }
  window.browser.setTabSelection?.([...selectedTabs]);
}

function clickTab(e, id) {
  const activeId = lastTabState?.activeId;
  const order = stripOrder();
  if (e.shiftKey) {
    const anchor = order.includes(selectionAnchor) ? selectionAnchor : activeId;
    const a = order.indexOf(anchor), b = order.indexOf(id);
    if (a !== -1 && b !== -1) {
      selectionAnchor = anchor;
      setSelection(order.slice(Math.min(a, b), Math.max(a, b) + 1));
    }
  } else if (isMac ? e.metaKey : e.ctrlKey) {
    const current = new Set(selectedTabs.size ? selectedTabs : [activeId]);
    if (current.has(id)) {
      if (current.size === 1) return; // the last selected tab stays selected
      current.delete(id);
      setSelection([...current]);
      if (id !== activeId) return;
      // Taking the active tab out: the next selected tab along (else the one before) takes over.
      const i = order.indexOf(id);
      id = order.slice(i + 1).find((x) => current.has(x)) ?? order.slice(0, i).reverse().find((x) => current.has(x)) ?? id;
    } else {
      current.add(id);
      setSelection([...current]);
    }
    selectionAnchor = id;
  } else {
    selectionAnchor = id;
    setSelection([]);
  }
  window.browser.switchTab(id);
}

// Tabs that closed leave the selection; so does everything, when another tab becomes active some
// other way (the keyboard, a link opening a tab, the tab search).
function pruneSelection(state) {
  if (!selectedTabs.size) return;
  const ids = new Set(state.tabs.map((tab) => tab.id));
  const kept = [...selectedTabs].filter((id) => ids.has(id));
  setSelection(kept.includes(state.activeId) ? kept : []);
}

// ---------- tab hover cards (Chrome) ----------
// Resting on a tab for a moment shows its title and site in a card under it; while one is up,
// moving along the strip carries it from tab to tab at once. A press, a drag, a scroll or leaving
// the strip puts it away. The page view is a native view drawn over this document, so the card has
// to fit in the toolbar row under the strip: the title gets one line here, where Chrome gives two.

const HOVER_CARD_DELAY_MS = 500;
const HOVER_CARD_WARM_MS = 300; // back on the strip within this long: the next card shows at once
let hoverCardEl = null;
let hoverCardTab = null; // the tab element the card is for (or is waiting to show for)
let hoverCardTimer = 0;
let hoverCardWarmUntil = 0;
let hoverCardPressed = null; // a tab pressed while hovered: no card for it until the pointer leaves it

function hoverCardHost(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.host.replace(/^www\./, '');
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname);
    return `${u.protocol}//${u.host}`; // lumen://settings and the like
  } catch {
    return url;
  }
}

function fillHoverCard(el) {
  const tab = lastTabState?.tabs.find((x) => String(x.id) === el.dataset.id);
  if (!tab) return false;
  hoverCardEl.querySelector('.hover-card-title').textContent = tab.title;
  const host = hoverCardHost(tab.url);
  const hostEl = hoverCardEl.querySelector('.hover-card-host');
  hostEl.textContent = host;
  hostEl.hidden = !host;
  return true;
}

function placeHoverCard(el) {
  const r = el.getBoundingClientRect();
  const width = hoverCardEl.offsetWidth;
  const x = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
  // Under the tab, but never past the top of the page view, which would cover it.
  const y = Math.min(r.bottom + 4, viewport.getBoundingClientRect().top - hoverCardEl.offsetHeight - 2);
  hoverCardEl.style.left = `${Math.round(x)}px`;
  hoverCardEl.style.top = `${Math.round(y)}px`;
}

function showHoverCard(el) {
  if (!hoverCardEl) {
    hoverCardEl = Object.assign(document.createElement('div'), { className: 'tab-hover-card', hidden: true });
    hoverCardEl.setAttribute('aria-hidden', 'true'); // the tab's own label already says all this
    hoverCardEl.append(Object.assign(document.createElement('div'), { className: 'hover-card-title' }), Object.assign(document.createElement('div'), { className: 'hover-card-host' }));
    document.body.append(hoverCardEl);
  }
  if (!el.isConnected || !fillHoverCard(el)) return;
  const moving = !hoverCardEl.hidden;
  hoverCardEl.classList.toggle('moving', moving && !motionReduced()); // slides along the strip
  hoverCardEl.hidden = false;
  placeHoverCard(el);
  if (!moving) hoverCardEl.animate(motionReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: 150, easing: 'ease-out' });
}

function hideHoverCard() {
  clearTimeout(hoverCardTimer);
  if (hoverCardEl && !hoverCardEl.hidden) {
    hoverCardEl.hidden = true;
    hoverCardWarmUntil = Date.now() + HOVER_CARD_WARM_MS;
  }
  hoverCardTab = null;
}

function hoverTab(el) {
  if (el === hoverCardTab || drag?.moved || renamingGroup !== null) return;
  if (el !== hoverCardPressed) hoverCardPressed = null;
  if (hoverCardPressed) return;
  const shown = hoverCardEl && !hoverCardEl.hidden;
  clearTimeout(hoverCardTimer);
  hoverCardTab = el;
  if (shown || Date.now() < hoverCardWarmUntil) showHoverCard(el);
  else hoverCardTimer = setTimeout(() => { if (hoverCardTab === el) showHoverCard(el); }, HOVER_CARD_DELAY_MS);
}

// After a strip update: the card follows its tab's new title and place, or goes with the tab.
function updateHoverCard() {
  if (!hoverCardTab) return;
  if (!hoverCardTab.isConnected) { hideHoverCard(); return; }
  if (hoverCardEl && !hoverCardEl.hidden) {
    hoverCardEl.classList.remove('moving');
    if (fillHoverCard(hoverCardTab)) placeHoverCard(hoverCardTab);
    else hideHoverCard();
  }
}

$('tabs').addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  const el = e.target.closest('.tab');
  // Over the speaker, its own tooltip says what a click does; the card would sit on top of it.
  if (!el || e.target.closest('.tab-audio')) { if (hoverCardTab) hideHoverCard(); return; }
  hoverTab(el);
});
$('tabs').addEventListener('pointerleave', () => { hoverCardPressed = null; hideHoverCard(); });
$('tabs').addEventListener('pointerdown', (e) => { hoverCardPressed = e.target.closest('.tab'); hideHoverCard(); }, true);
$('tabs').addEventListener('scroll', hideHoverCard, { passive: true });
// Backstop for a leave that isn't reported (the window-drag area around the strip takes the mouse).
document.addEventListener('pointermove', (e) => { if (hoverCardTab && !$('tabs').contains(e.target)) hideHoverCard(); }, { passive: true });
window.addEventListener('blur', hideHoverCard);
window.addEventListener('resize', hideHoverCard);

// ---------- closing tabs in a row (Chrome) ----------
// A tab closed with its ✕ (or a middle-click) leaves the other tabs at the widths they had until the
// pointer leaves the strip: the next tab slides in under the pointer, its ✕ where the last one was,
// so a run of tabs can be closed by clicking in one place. Then they widen into the freed room.

let widthsHeld = false;
let widthsFrame = 0;

function holdTabWidths() {
  for (const el of $('tabs').querySelectorAll('.tab:not(.pinned):not(.tab-ghost)')) el.style.flex = `0 0 ${getComputedStyle(el).width}`;
  widthsHeld = true;
}

function releaseTabWidths(animate = !motionReduced()) {
  if (!widthsHeld) return;
  widthsHeld = false;
  const strip = $('tabs');
  cancelAnimationFrame(widthsFrame);
  strip.classList.toggle('reflowing', animate);
  for (const el of strip.querySelectorAll('.tab')) el.style.flex = '';
  if (!animate) { placeIndicator(false); updateOverflow(); return; }
  // The active tab's surface is placed from layout, so it follows the tabs while they widen.
  const end = performance.now() + 460;
  const follow = (now) => {
    placeIndicator(false);
    if (now < end) { widthsFrame = requestAnimationFrame(follow); return; }
    strip.classList.remove('reflowing');
    placeIndicator(false);
    updateOverflow();
  };
  widthsFrame = requestAnimationFrame(follow);
}
$('tabs').addEventListener('pointerleave', () => releaseTabWidths());
document.addEventListener('pointermove', (e) => { if (widthsHeld && !$('tabs').contains(e.target)) releaseTabWidths(); }, { passive: true });
window.addEventListener('resize', () => releaseTabWidths(false));

const organizeBtn = $('organize-tabs');
organizeBtn.onclick = () => window.browser.organizeTabs();
window.browser.onOrganizing?.((busy) => {
  // busy: true (grouping on this computer), 'refine' (the groups are shown, the AI is refining them: a click cancels), false.
  organizeBtn.classList.toggle('busy', Boolean(busy));
  organizeBtn.disabled = busy === true;
  organizeBtn.querySelector('span').textContent = busy === 'refine' ? t('tabs.refining') : busy ? t('tabs.organizing') : t('tabs.organize');
});
// "Organized (no AI needed)", "Grouped your loose tabs while you were away": a short note with Undo.
window.browser.onOrganizeNote?.(({ text, undo }) => {
  document.querySelector('.organize-note')?.remove();
  const note = Object.assign(document.createElement('div'), { className: 'organize-note', role: 'status' });
  note.append(Object.assign(document.createElement('span'), { textContent: text }));
  if (undo) {
    note.append(Object.assign(document.createElement('button'), { textContent: t('organize.undo'), onclick: () => { window.browser.undoOrganize(); note.remove(); } }));
  }
  organizeBtn.after(note); // in the strip's own row: web pages cover everything below it
  setTimeout(() => note.remove(), 9000);
});

function renderTabs(state) {
  if (drag || renamingGroup !== null || stripPressed) {
    pendingState = state;
    return;
  }
  lastTabState = state;
  pruneSelection(state);
  const container = $('tabs');
  const before = new Map();
  for (const el of container.querySelectorAll('.tab, .group-label')) before.set(el.dataset.id, { el, rect: el.getBoundingClientRect() });
  const switched = state.activeId !== lastActiveId;
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
  // Tabs and group labels are kept and updated in place, keyed by id, rather than rebuilt: a click
  // (on a tab, its ✕, a group label) that straddled an update used to land on an element that had
  // just been thrown away, and did nothing.
  const wanted = [];
  for (const tab of state.tabs) {
    const group = tab.groupId ? groupsById.get(tab.groupId) : null;
    if (group && currentGroup !== group.id) {
      wanted.push(groupLabel(group, state.tabs.filter((t) => t.groupId === group.id).length, crowded, before.get(`g${group.id}`)?.el));
    }
    currentGroup = group ? group.id : null;
    if (group?.collapsed && tab.id !== state.activeId) continue; // the active tab stays visible
    wanted.push(updateTabEl(before.get(String(tab.id))?.el || createTabEl(tab.id), tab, group, state.activeId));
  }
  const keep = new Set(wanted);
  for (const { el } of before.values()) if (!keep.has(el)) el.remove();
  // Only elements out of place move, so the rest aren't detached mid-click.
  let cursor = tabIndicator.nextSibling;
  for (const el of wanted) {
    if (el === cursor) cursor = el.nextSibling;
    else container.insertBefore(el, cursor);
  }

  // A tab arriving while widths are held (see holdTabWidths) would be squeezed in beside them.
  if (widthsHeld && wanted.some((el) => el.classList.contains('tab') && !before.has(el.dataset.id))) releaseTabWidths(false);
  animateTabs(before, container);
  updateHoverCard();
  const activeId = container.querySelector('.tab.active')?.dataset.id;
  placeIndicator(tabsRendered && !motionReduced() && [...before.keys()].includes(activeId));
  tabsRendered = true;
  updateOverflow();
  syncTabStripKeyboard();

  // Scrolled into view when the active tab changes, not on every update: a page loading in the
  // active tab kept yanking the strip back while you scrolled it to reach another tab.
  const activeEl = container.querySelector('.tab.active');
  if (activeEl && (switched || !before.has(activeId))) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: motionReduced() ? 'auto' : 'smooth' });

  const active = state.tabs.find((t) => t.id === state.activeId);
  if (state.activeId !== lastActiveId) {
    lastActiveId = state.activeId;
    closeFind();
  }
  currentError = Boolean(active?.error);
  currentSecurity = active?.security || null;
  const zoom = active?.zoom ?? 100;
  const zoomed = zoom !== (active?.zoomDefault ?? 100); // [settings] the default zoom from Settings isn't "zoomed"
  $('zoom').hidden = !zoomed;
  $('zoom').textContent = `${zoom}%`;
  document.body.classList.toggle('zoomed', zoomed);
  const lumenPage = active?.page === 'reader' || active?.page === 'source'; // shows a web address, but is Lumen's own page
  currentLumenPage = lumenPage;
  const reader = $('reader');
  reader.hidden = !(active?.readerable || active?.page === 'reader') || currentError;
  reader.setAttribute('aria-pressed', String(active?.page === 'reader'));
  reader.title = active?.page === 'reader' ? 'Leave reader mode' : 'Reader mode';
  const star = $('bookmark');
  star.hidden = !active?.url || currentError || lumenPage;
  star.setAttribute('aria-pressed', String(Boolean(active?.bookmarked)));
  star.title = active?.bookmarked ? t('bookmark.remove.title') : t('bookmark.add.title');
  star.setAttribute('aria-label', active?.bookmarked ? t('bookmark.remove') : t('bookmark.add'));
  if (active && (!addressDirty || document.activeElement !== address)) {
    currentUrl = active.url;
    addressDirty = false;
    // Focused: only rewrite a changed URL, and keep a full selection. Assigning .value (even the same
    // text) drops the selection, so any tab update (a title, a favicon, a page loading) right after a
    // click in the address bar left nothing selected.
    if (document.activeElement === address) {
      if (address.value !== currentUrl) {
        const all = address.selectionStart === 0 && address.selectionEnd === address.value.length;
        address.value = currentUrl;
        if (all) address.select();
      }
    } else showAddress();
  }
  $('loadbar').hidden = !active?.loading;
  document.body.classList.toggle('tab-loading', Boolean(active?.loading));
  $('back').disabled = !state.canGoBack;
  $('forward').disabled = !state.canGoForward;
  $('reload-icon').innerHTML = active?.loading
    ? '<path d="M4 4l8 8M12 4l-8 8"/>'
    : '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5"/>';
  $('reload').title = active?.loading ? t('toolbar.stop') : t('toolbar.reload.title');
  $('reload').setAttribute('aria-label', active?.loading ? t('toolbar.stop') : t('toolbar.reload'));
}

window.browser.onTabs(renderTabs);
window.browser.onFocusAddress(() => { window.browser.addressTouched?.(); address.focus(); address.select(); });

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
    { items: suggest.items.map(({ kind, title, detail }) => ({ kind, title, detail })), selected: suggest.selected, listId: ++suggestListId },
  );
  shownSuggestions = { id: suggestListId, items: suggest.items };
}

// The list on screen, kept after hideSuggestions() clears `suggest`: a click in the dropdown hides
// it (the address bar loses focus) before the pick's round trip through main arrives, which used
// to find an empty list and drop the click. The id makes sure the pick is from this very list.
let suggestListId = 0;
let shownSuggestions = { id: 0, items: [] };

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

  const search = { kind: 'search', title: text, detail: t('address.searchWith', { engine: searchEngine.label }), go: searchUrl(text) };
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

window.browser.onSuggestionPicked(({ index, listId }) => {
  if (listId !== shownSuggestions.id) return; // a pick from a list that has since been replaced
  const item = shownSuggestions.items[index];
  if (item) navigate(item.go);
});

address.addEventListener('input', (e) => {
  addressDirty = true;
  updateSuggestions(address.value, e.inputType?.startsWith('delete'));
});
address.addEventListener('focus', () => {
  // Focus coming back while you type (a loading page briefly took it) must not select the typed
  // text, or the next key would replace it.
  if (addressDirty) return;
  address.value = currentUrl;
  address.select();
});
// A click or typing anywhere in the browser UI (not a shortcut like Ctrl+T) is the user working
// here: a new tab that is still loading must not take the keyboard away (see main.js).
document.addEventListener('pointerdown', () => window.browser.addressTouched?.(), true);
document.addEventListener('keydown', (e) => { if (!e.ctrlKey && !e.metaKey && !e.altKey) window.browser.addressTouched?.(); }, true);
// The first click selects the whole address (as in Chrome and Safari); the mouseup would otherwise
// drop a caret somewhere in it. A drag still selects part of it.
let selectOnMouseUp = false;
address.addEventListener('mousedown', () => { selectOnMouseUp = document.activeElement !== address || !document.hasFocus(); });
address.addEventListener('mouseup', () => {
  if (selectOnMouseUp && address.selectionStart === address.selectionEnd) address.select();
  selectOnMouseUp = false;
});
address.addEventListener('blur', () => {
  // When the page (another view) takes focus, activeElement stays on the address bar, so check
  // hasFocus too: otherwise the suggestion view stayed up over the page and swallowed clicks.
  setTimeout(() => { if (document.activeElement !== address || !document.hasFocus()) hideSuggestions(); }, 150); // let a dropdown pick land first
  if (!addressDirty) showAddress();
});
window.addEventListener('blur', () => setTimeout(() => { if (!document.hasFocus()) hideSuggestions(); }, 150));
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
// Rough, on purpose: only decides whether Ask AI mode (below) treats the text as an address.
const looksLikeAddress = (text) => /^[a-z][a-z\d+.-]*:\/\//i.test(text) || /^localhost(:\d+)?(\/|$)/i.test(text) || /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(text);

$('omnibox').addEventListener('submit', async (e) => {
  e.preventDefault();
  const item = suggest.items[suggest.selected];
  // What was typed, without an inline completion still selected after it.
  const completing = address.selectionStart > 0 && address.selectionStart < address.value.length && address.selectionEnd === address.value.length;
  const typed = (completing ? address.value.slice(0, address.selectionStart) : address.value).trim();
  // On the new-tab page in Ask AI mode, a question typed in the address bar goes to the assistant,
  // as it would in the page's own box; an address still opens.
  if (!item && typed && !looksLikeAddress(typed) && (await window.browser.homeMode?.()) === 'ask') {
    hideSuggestions();
    addressDirty = false;
    address.blur();
    showSidebar(true);
    ask(typed);
    return;
  }
  navigate(item ? item.go : address.value.trim());
});

$('back').onclick = () => window.browser.back();
$('forward').onclick = () => window.browser.forward();
$('reload').onclick = () => window.browser.reload();
$('zoom').onclick = () => window.browser.resetZoom?.();
$('bookmark').onclick = () => window.browser.toggleBookmark?.();
$('reader').onclick = () => window.browser.toggleReader?.();
$('new-tab').onclick = () => window.browser.newTab(); // the new tab's search box takes the keyboard
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
  findHideTimer = setTimeout(() => { if (!findbar.classList.contains('open')) findbar.hidden = true; }, motionReduced() ? 0 : 420);
}

function findStep(forward) {
  if (findInput.value) window.browser.find(findInput.value, { forward, findNext: true });
}

window.browser.onOpenFind(openFind);
window.browser.onFindResult(({ activeMatchOrdinal, matches }) => {
  $('find-count').textContent = findInput.value ? (matches ? t('find.count', { current: activeMatchOrdinal, total: matches }) : t('find.none')) : '';
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
  } else if (!revealAnim && !motionReduced() && !snapshot) {
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
  if (motionReduced()) finish();
  else {
    // Starting from rest: let the first layout/paint of the sidebar and snapshot land before
    // motion begins, so any slow frame is a still frame, not a jump.
    revealAnim = springTo(reveal, target, { response: visible ? 0.34 : 0.28, velocity, onUpdate: setReveal, onDone: finish });
  }
  if (visible) $('prompt').focus({ preventScroll: true });
}
$('toggle-sidebar').onclick = () => {
  if (chatFull) { exitFull(); return; } // the toggle docks a full chat back rather than closing it
  showSidebar($('toggle-sidebar').getAttribute('aria-pressed') !== 'true');
};
// Start the page snapshot as soon as the button is pressed; the click arrives a little later.
$('toggle-sidebar').addEventListener('pointerdown', (e) => {
  if (e.button === 0 && !revealAnim && !snapshot && !motionReduced()) earlyFreeze = freezePage();
});

// Resizable from the sidebar's left edge; the width is remembered. Double-click resets it.
const SIDEBAR_MIN = 300, SIDEBAR_MAX = 560, SIDEBAR_DEFAULT = 360;
let sidebarWish = null; // the width the user chose; a narrow window may hold it smaller for now
function setSidebarWidth(width) {
  sidebarWish = width;
  const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - 420)); // the page keeps 420px
  const w = Math.round(Math.min(max, Math.max(SIDEBAR_MIN, width)));
  document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
  reportBounds();
  return w;
}
const savedWidth = Number(localStorage.getItem('sidebarWidth'));
if (savedWidth) setSidebarWidth(savedWidth);
const resizer = $('sidebar-resize');
let lastHandlePress = 0;
resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault(); // (this also suppresses mousedown/dblclick, so double-click is detected here)
  if (e.timeStamp - lastHandlePress < 400) {
    lastHandlePress = 0;
    localStorage.setItem('sidebarWidth', String(setSidebarWidth(SIDEBAR_DEFAULT)));
    return;
  }
  lastHandlePress = e.timeStamp;
  const startX = e.clientX;
  const startWidth = $('sidebar').getBoundingClientRect().width;
  resizer.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  // The page is a native view: once the pointer is over it, it takes the mouse moves (the drag
  // stalls and the cursor changes). For the drag it is shown as a snapshot, like during the spring.
  const frozen = !snapshot && !motionReduced() ? freezePage() : null;
  let frame = 0;
  const move = (ev) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => setSidebarWidth(startWidth + (startX - ev.clientX)));
  };
  const up = async () => {
    resizer.removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    localStorage.setItem('sidebarWidth', String(Math.round($('sidebar').getBoundingClientRect().width)));
    if (frozen) { await frozen; thawPage(); }
  };
  resizer.addEventListener('pointermove', move);
  // Fires after pointerup or pointercancel, and if capture is lost any other way: the drag always ends.
  resizer.addEventListener('lostpointercapture', up, { once: true });
});
// A smaller window narrows the sidebar (the page keeps room); a bigger one gives the chosen width back.
window.addEventListener('resize', () => { if (sidebarWish) setSidebarWidth(sidebarWish); });
resizer.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const width = setSidebarWidth($('sidebar').getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 20 : -20));
  localStorage.setItem('sidebarWidth', String(width));
});
window.browser.onToggleSidebar(() => showSidebar($('toggle-sidebar').getAttribute('aria-pressed') !== 'true'));

// ---------- full-page chat ("Ask AI" from the homepage) ----------

// fullChatTabId remembers which tab's chat should fill the whole content area; it survives
// switching to another tab (so switching back re-enters full mode) but is forgotten for good once
// that tab leaves the new-tab page or closes. The conversation itself is one shared chat either
// way — full mode is only ever a layout, never a separate thread.
let fullChatTabId = null;
let chatFull = false;
const isNewTabPage = (tab) => Boolean(tab) && !tab.url && !tab.page && !tab.error;

function enterFull() {
  if (chatFull) return;
  chatFull = true;
  document.body.classList.add('chat-full');
  window.browser.setChatFull?.(true); // main hides the tab's native view; see layout() in main.js
  // Full mode has no docked-sidebar spring of its own; don't leave one (or its frozen-page snapshot) running underneath.
  revealAnim?.stop();
  revealAnim = null;
  heldRect = null;
  if (snapshot) thawPage();
  // Full mode ignores --reveal (CSS forces width: 100%), but reset it so docking back later — which
  // does nothing but remove the chat-full class — lands on a fully open sidebar, not a stale partial one.
  document.body.classList.remove('sidebar-hidden');
  $('sidebar').style.removeProperty('--reveal');
  reveal = 1;
  $('toggle-sidebar').setAttribute('aria-pressed', 'true');
  $('prompt').focus({ preventScroll: true });
}

// tell=false: a tab switch. Main keeps the chat tied to that tab (it shows the other tab's page by
// itself and hides this one again on the way back, with no flash), so it isn't told.
function exitFull(tell = true) {
  if (!chatFull) return;
  chatFull = false;
  document.body.classList.remove('chat-full');
  // Bounds before visibility: main should already have the docked size cached by the time it shows
  // the view again, instead of showing it at whatever (near-zero) size it was hidden at.
  reportBounds();
  // Docked on purpose (button, Escape, toggle): forget the tab too, or the next tab update re-enters.
  if (tell) { fullChatTabId = null; window.browser.setChatFull?.(false); }
}

// Tab switches and navigation leave (or re-enter) full mode from outside the chat; the toggle
// button, Escape and the dock icon below cover leaving it from inside the chat.
function watchFullChatTab(state) {
  if (fullChatTabId === null) return;
  const tab = state.tabs.find((t) => t.id === fullChatTabId);
  if (!tab || !isNewTabPage(tab)) { fullChatTabId = null; exitFull(); return; } // navigated away, or closed
  if (state.activeId === fullChatTabId) enterFull(); // switched back while still on the new-tab page
  else exitFull(false); // a different tab is active: dock back, but keep remembering this one
}
window.browser.onTabs(watchFullChatTab);

$('dock-to-side').onclick = () => exitFull();
// Escape anywhere in the chat docks a full-page chat back, except inside the model picker's own
// search popup, which handles Escape itself (closing the popup, not the chat).
$('sidebar').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && chatFull && !e.target.closest('.model-picker')) { e.preventDefault(); exitFull(); }
});

// "Ask AI" on the new-tab page: that tab's chat opens full-page instead of docking to the side.
window.browser.onAskFromHome?.(({ text, tabId }) => {
  fullChatTabId = tabId ?? lastTabState?.activeId ?? null;
  enterFull();
  ask(text);
});
window.browser.onAskSelection((text) => {
  showSidebar(true);
  ask(t('ask.selection', { text }));
});

// "Ask AI about this" on a screenshot: the PNG (base64) goes into the sidebar's composer.
window.browser.onAttachImage?.(async (base64) => {
  showSidebar(true);
  try {
    const bytes = Uint8Array.from(atob(String(base64)), (c) => c.charCodeAt(0));
    await addImages([new File([bytes], 'screenshot.png', { type: 'image/png' })]);
    prompt.focus();
  } catch { /* an unreadable image is skipped, as with a pasted one */ }
});

// ---------- settings: in lumen://settings; the sidebar keeps the search engine in sync ----------

window.assistant.onSearchEngine?.((engine) => { searchEngine = engine; });
window.assistant.getSettings().then((s) => {
  const current = s.searchEngines?.find((e) => e.id === s.searchEngine);
  if (current) searchEngine = current;
});

// Anything else dropped on the window must never navigate the UI itself (main.js refuses that too):
// a dropped file or web link opens as a new tab; text dropped into a text field still lands there.
const editableTarget = (el) => Boolean(el?.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]'));
const hasFiles = (dt) => [...(dt?.types || [])].includes('Files');
document.addEventListener('dragover', (e) => {
  if (e.defaultPrevented) return; // the sidebar is taking an image
  if (editableTarget(e.target) && !hasFiles(e.dataTransfer)) return;
  e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (e.defaultPrevented) return;
  if (editableTarget(e.target) && !hasFiles(e.dataTransfer)) return;
  e.preventDefault();
  if (e.dataTransfer.files.length) { window.browser.openFiles(e.dataTransfer.files); return; }
  const dropped = (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'))
    || e.dataTransfer.getData('text/plain').trim();
  if (/^https?:\/\/\S+$/i.test(dropped || '')) window.browser.newTab(dropped);
});

// ---------- downloads indicator ----------

const downloadsBtn = $('downloads');
const RING = 2 * Math.PI * 10;
let downloadStates = new Map();
let pulseTimer = null;

window.browser.onDownloads?.((list) => {
  if (!Array.isArray(list)) return;
  downloadsBtn.hidden = !list.length; // an emptied (cleared) list hides the button again
  if (!list.length) { downloadStates = new Map(); downloadsBtn.classList.remove('progressing', 'finished'); return; }
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
    ? (latest.total ? `${Math.round((latest.received / latest.total) * 100)}%` : t('downloads.downloading'))
    : latest.state === 'completed' ? t('downloads.done') : ['cancelled', 'interrupted'].includes(latest.state) ? t(`downloads.${latest.state}`) : latest.state;
  downloadsBtn.title = `${latest.name} — ${status}`;
});
downloadsBtn.onclick = () => {
  const r = downloadsBtn.getBoundingClientRect();
  window.browser.openDownloadsMenu?.({ right: Math.round(r.right), bottom: Math.round(r.bottom) });
};

// Pause looping indicators (the live dot, the working line) while the window is in the background.
window.browser.onWindowFocus?.((focused) => document.body.classList.toggle('window-inactive', !focused));

// ---------- the chat's hooks into the sidebar (chat-core.js) ----------

chatHost.running = () => reportBounds(); // the AI frame around the page appears and goes with a reply
chatHost.needSidebar = () => { if (document.body.classList.contains('sidebar-hidden')) showSidebar(true); };
chatHost.identity = (who, first) => {
  const button = $('toggle-sidebar');
  button.title = `${who.name} (Ctrl+J)`;
  button.dataset.assistant = who.name;
  button.setAttribute('aria-label', who.name);
  button.style.setProperty('--assistant-tint', who.tint);
  const swap = () => {
    button.querySelector('svg')?.remove();
    button.insertAdjacentHTML('afterbegin', who.svg);
  };
  if (first || motionReduced()) swap();
  else {
    // Cross-fade: the old mark shrinks away, the new one springs in.
    button.classList.add('mark-out');
    setTimeout(() => { swap(); button.classList.remove('mark-out'); button.classList.add('mark-in'); setTimeout(() => button.classList.remove('mark-in'), 420); }, 120);
  }
};

// ---------- the full-page chat (lumen://chat, features/chat-page.js) ----------

// The button in the header, the menu item and Ctrl+Shift+L open this chat as a page; main folds the
// sidebar away when it opens and brings it back when the page's "Back to sidebar" closes it.
$('open-chat-page').onclick = () => window.assistant.openFullPage();
window.assistant.onSidebar?.((visible) => {
  // aria-pressed is the wish (showSidebar sets it at once), so two quick calls (open, back) end where the last one says.
  if (($('toggle-sidebar').getAttribute('aria-pressed') === 'true') !== Boolean(visible)) showSidebar(Boolean(visible));
});

startChat();

// ---------- AI agents over MCP (session B) ----------
// External agents (Claude Code, Codex, Gemini CLI…) drive the browser; their calls show here.

const mcpSteps = new Map(); // step id -> row
let mcpPillText = null;
// An outside agent opens and closes a session around each task, so the pill (not the chat) carries
// the state: it holds "driving" for a moment after a session ends so a quick reconnect doesn't
// flicker, and the chat gets one line the first time each agent connects in this window, never one per session.
const MCP_PILL_HOLD_MS = 1500;
const mcpAnnounced = new Set();
let mcpPillTimer = null;

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
      const driving = event.active || event.remaining > 0;
      const showPill = () => {
        document.body.classList.toggle('mcp-active', driving);
        const text = document.querySelector('#agent-pill span:not(.agent-dot)');
        if (!text) return;
        if (mcpPillText === null) mcpPillText = text.textContent;
        text.textContent = driving ? t('mcp.driving', { client: event.clientName }) : mcpPillText;
      };
      clearTimeout(mcpPillTimer);
      if (driving) showPill();
      else mcpPillTimer = setTimeout(showPill, MCP_PILL_HOLD_MS);
      if (event.active && !mcpAnnounced.has(event.clientName)) {
        mcpAnnounced.add(event.clientName);
        append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('mcp.connected', { client: event.clientName }) }));
      }
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
      if (document.body.classList.contains('sidebar-hidden')) showSidebar(true);
      showApproval(event.approvalId, event.host, { action: event.action, title: event.title, query: event.query });
      const card = approvals.get(event.approvalId)?.card;
      const title = card?.querySelector('.approval-title');
      const vars = { client: event.clientName, host: event.host, file: event.host, query: event.query };
      if (title) title.textContent = t(event.query !== undefined ? 'mcp.approval.search' : event.action === 'open' ? 'mcp.approval.open' : event.action === 'pdf' ? 'mcp.approval.pdf' : event.action === 'script' ? 'mcp.approval.script' : 'mcp.approval.interact', vars);
      card?.querySelector('.approval-always')?.remove(); // auto-allow is for the sidebar's AI only
      if (event.action === 'open' && event.query === undefined) { const detail = card?.querySelector('.approval-detail'); if (detail) detail.textContent = t('mcp.approval.detail.open'); }
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

// [settings] UI preferences set in lumen://settings, and the accent colour: ui-prefs.js (shared with the chat page).
