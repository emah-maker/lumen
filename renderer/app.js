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

function startTabDrag(e, el, id) {
  if (e.button !== 0 || e.target.closest('.tab-close, .tab-audio')) return;
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
    window.browser.closeTab(id);
  });
  el.addEventListener('pointerleave', () => { closePressed = false; });
  close.onclick = (e) => { e.stopPropagation(); if (e.detail === 0) window.browser.closeTab(id); }; // detail 0: Enter/Space
  inner.append(globeIcon(), title, close);
  el.append(inner);
  el.onclick = () => { if (!suppressClick && !closedByPress) window.browser.switchTab(id); };
  // A middle press would otherwise start Chromium's autoscroll, which swallows the auxclick.
  el.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); };
  el.onauxclick = (e) => { if (e.button === 1) window.browser.closeTab(id); };
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
  el.className = 'tab' + (active ? ' active' : '') + (group ? ' grouped' : '') + (tab.sleeping ? ' sleeping' : '') + (tab.pinned ? ' pinned' : '') + (tab.alert ? ' alert' : '');
  if (group) el.style.setProperty('--group-color', `var(--g-${group.color})`);
  else el.style.removeProperty('--group-color');
  el.setAttribute('aria-selected', String(active));
  el.title = tab.title;
  el.setAttribute('aria-label', tab.title);
  // The icon is only swapped when it changes: a new <img> on every update restarted its fade-in.
  const favicons = tab.favicons?.length ? tab.favicons : tab.favicon ? [tab.favicon] : [];
  const iconKey = tab.loading ? 'loading' : favicons.length && !tab.error ? `img:${favicons.join(' ')}` : `page:${tab.page || ''}`;
  if (el.dataset.icon !== iconKey) {
    el.dataset.icon = iconKey;
    let icon;
    if (tab.loading) {
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
  el.querySelector('.tab-close').title = t('tabs.close', { title: tab.title });
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

const organizeBtn = $('organize-tabs');
organizeBtn.onclick = () => window.browser.organizeTabs();
window.browser.onOrganizing?.((busy) => {
  organizeBtn.classList.toggle('busy', busy);
  organizeBtn.disabled = busy;
  organizeBtn.querySelector('span').textContent = busy ? t('tabs.organizing') : t('tabs.organize');
});

function renderTabs(state) {
  if (drag || renamingGroup !== null || stripPressed) {
    pendingState = state;
    return;
  }
  lastTabState = state;
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

  animateTabs(before, container);
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

// ---------- settings: in lumen://settings; the sidebar keeps the search engine in sync ----------

window.assistant.onSearchEngine?.((engine) => { searchEngine = engine; });
window.assistant.getSettings().then((s) => {
  const current = s.searchEngines?.find((e) => e.id === s.searchEngine);
  if (current) searchEngine = current;
});
// The gear (and "Set up AI" on errors) open the AI section of Settings.
const openAiSettings = () => window.lumenPrefs?.openSettingsPage('you-and-ai');
$('open-settings').onclick = openAiSettings;

// "Set up an AI" in the empty sidebar, while nothing is connected: three equal ways in. `s.model`
// is main's single source of truth for "is anything usable right now" — no client-side guessing,
// so this can never disagree with the picker (see loadModels below).
async function refreshSetup() {
  const s = await window.assistant.getSettings();
  // A local engine (Claude Code, Grok Build) found but signed out can't answer yet: while it's the
  // pick, the card stays up.
  const signedOut = s.models.find((m) => m.id === 'claudecode:default')?.signedIn === false;
  const pickSignedOut = s.models.find((m) => m.id === s.model)?.signedIn === false;
  $('setup').hidden = Boolean(s.model) && !pickSignedOut;
  $('setup-claude-code-detail').textContent = !s.claudeCode
    ? t('setup.claudeCode.install')
    : signedOut
      ? t('setup.claudeCode.signedOut')
      : t('setup.claudeCode.ready');
  $('setup-claude-code').disabled = !s.claudeCode;
}
$('setup-claude-code').onclick = async () => {
  // Signed out a moment ago? Ask the CLI again first (the user may have just run /login).
  const status = await window.lumenExtras?.claudeCodeStatus?.(true).catch(() => null);
  if (status?.signedIn !== false && await window.assistant.setModel('claudecode:default')) await loadModels();
  refreshSetup();
};
$('setup-keys').onclick = openAiSettings;
// While the sign-in tab is open the button becomes Cancel (closing that tab cancels too).
let openRouterPending = false;
$('setup-openrouter').onclick = async () => {
  const btn = $('setup-openrouter');
  const title = btn.querySelector('.setup-name') || btn;
  if (openRouterPending) { window.assistant.cancelOpenRouterSignIn?.(); return; }
  openRouterPending = true;
  const label = title.textContent;
  title.textContent = t('setup.openrouter.cancel');
  try {
    const r = await window.assistant.openRouterSignIn();
    if (r?.ok) { await loadModels(); refreshSetup(); }
    else if (r?.message && !r.cancelled) alert(r.message);
  } catch (err) {
    alert(t('setup.openrouter.failed', { error: err?.message || err }));
  } finally {
    openRouterPending = false;
    title.textContent = label;
  }
};
window.assistant.onModelsUpdated?.(() => refreshSetup());
refreshSetup();

// ---------- model picker ----------

// ---------- the toolbar AI button follows the model's company ----------

// Simple monochrome marks (drawn here, sized for 16px), tinted per company.
const ASSISTANTS = {
  // Nothing connected: no provider to privilege, so a neutral mark instead of defaulting to Claude's.
  AI: {
    name: 'AI',
    tint: 'currentColor',
    svg: '<svg viewBox="0 0 16 16" class="mark"><circle cx="8" cy="8" r="5.25"/></svg>',
  },
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
  OpenRouter: {
    name: 'OpenRouter',
    tint: 'currentColor',
    // A neutral routing glyph: one line branching to three.
    svg: '<svg viewBox="0 0 16 16" class="mark"><path d="M2.5 8h4.5M7 8c2 0 2.5-4 5-4M7 8c2 0 2.5 4 5 4M7 8h5"/><circle cx="13" cy="4" r="1"/><circle cx="13" cy="8" r="1"/><circle cx="13" cy="12" r="1"/></svg>',
  },
  Gemini: {
    name: 'Gemini',
    tint: 'url(#gemini-grad)',
    svg: '<svg viewBox="0 0 16 16" class="mark filled"><defs><linearGradient id="gemini-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f8cff"/><stop offset="1" stop-color="#a86bff"/></linearGradient></defs><path d="M8 1.6C8.5 5 11 7.5 14.4 8 11 8.5 8.5 11 8 14.4 7.5 11 5 8.5 1.6 8 5 7.5 7.5 5 8 1.6Z"/></svg>',
  },
};
let assistantIdentity = null;

function setAssistantIdentity(group) {
  // Claude Code answers as Claude, Grok Build as Grok. No group (nothing connected) or an unknown
  // one: the neutral mark.
  const who = ASSISTANTS[group === 'Your Claude account' ? 'Claude' : group === 'Your Grok account' ? 'Grok' : group] || ASSISTANTS.AI;
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
  if (first || motionReduced()) swap();
  else {
    // Cross-fade: the old mark shrinks away, the new one springs in.
    button.classList.add('mark-out');
    setTimeout(() => { swap(); button.classList.remove('mark-out'); button.classList.add('mark-in'); setTimeout(() => button.classList.remove('mark-in'), 420); }, 120);
  }
  const empty = document.querySelector('#empty .empty-title');
  if (empty) empty.textContent = t('sidebar.empty', { name: who.name });
  const pill = $('agent-pill-text');
  if (pill) pill.textContent = t('agent.usingTab', { name: who.name });
}

window.lumenPicker($('model'));

// Whether there is any model to talk to right now (main's settings:get is the single source of
// truth); ask() below checks this before sending, instead of letting a request fail with an error.
let modelReady = false;
let modelGroups = new Map(); // model id -> its group ("Claude", "OpenAI", "Your Claude account", …)

async function loadModels() {
  const s = await window.assistant.getSettings();
  modelGroups = new Map(s.models.map((m) => [m.id, m.group]));
  const select = $('model');
  const picker = select.closest('.model-picker');
  modelReady = Boolean(s.model);
  if (picker) picker.hidden = !modelReady; // nothing connected: no picker, not an empty one
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
  if (modelReady) { select.value = s.model; select.pickerSync(); }
  const current = s.models.find((m) => m.id === s.model);
  select.title = current?.detail || '';
  prompt.placeholder = !current ? t('composer.setup') : t('composer.ask', { name: current.group === 'Claude' ? 'Claude' : current.label });
  setAssistantIdentity(current?.group);
}
window.assistant.onModelsUpdated?.(() => loadModels());
// "More models…" (OpenRouter): a searchable list of every model, under the picker.
async function openModelSearch() {
  document.querySelector('.model-search')?.remove();
  const box = Object.assign(document.createElement('div'), { className: 'picker-menu model-search' });
  const input = Object.assign(document.createElement('input'), { type: 'search', placeholder: t('models.search'), className: 'model-search-input' });
  input.setAttribute('aria-label', t('models.search'));
  const list = Object.assign(document.createElement('div'), { className: 'model-search-list', textContent: t('models.loading') });
  list.setAttribute('role', 'listbox');
  box.append(input, list);
  document.querySelector('.model-picker').append(box);
  input.focus();
  const close = () => { box.remove(); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!box.contains(e.target)) close(); };
  document.addEventListener('pointerdown', outside, true);
  let models = [];
  try { models = await window.assistant.openRouterModels(); } catch { list.textContent = t('models.loadFailed'); return; }
  const render = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = models.filter((m) => words.every((w) => `${m.id} ${m.name}`.toLowerCase().includes(w))).slice(0, 60);
    list.replaceChildren(...hits.map((m) => {
      const item = Object.assign(document.createElement('div'), { className: 'picker-item', tabIndex: -1, textContent: m.tools ? m.name : t('models.chatOnly', { name: m.name }), title: m.id });
      item.setAttribute('role', 'option');
      item.dataset.id = m.id;
      item.addEventListener('click', async () => {
        close();
        if (await window.assistant.setModel(`openrouter:${m.id}`)) await loadModels();
      });
      return item;
    }));
    if (!hits.length) list.textContent = t('models.none');
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter') list.querySelector('.picker-item')?.click();
  });
  render();
}

$('model').addEventListener('change', async (e) => {
  const select = e.target;
  if (select.value === 'openrouter:__more') {
    const s = await window.assistant.getSettings();
    select.value = s.model;
    select.pickerSync();
    openModelSearch();
    return;
  }
  const switched = await window.assistant.setModel(select.value).catch(() => false);
  if (!switched) {
    // Not accepted (it disconnected a moment ago, say): show what main actually uses.
    await loadModels();
    return;
  }
  const label = select.selectedOptions[0].textContent;
  select.title = select.selectedOptions[0].title;
  // From main's list, not the <optgroup>: a lone group is drawn without one (see loadModels).
  const group = modelGroups.get(select.value) ?? select.selectedOptions[0].parentElement?.label;
  prompt.placeholder = t('composer.ask', { name: group === 'Claude' ? 'Claude' : select.selectedOptions[0].textContent });
  setAssistantIdentity(group);
  modelReady = true; // picking a model from the (visible) picker means one is already connected
  refreshSetup();
  // The conversation carries over: the next message goes to the new model with the full history.
  // Mid-reply, the reply in progress finishes on the old model first (main says 'next-message').
  if (switched === 'next-message') {
    append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('models.switchNext', { name: label }) }));
  } else if (messages.querySelector('.msg')) {
    append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('models.switched', { name: label }) }));
  }
  prompt.focus();
});
loadModels();
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
  send.title = value ? t('composer.stop') : t('composer.send.title');
  send.setAttribute('aria-label', value ? t('composer.stop') : t('composer.send'));
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
    img.alt = t('composer.attachedImage', { n: i + 1 });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.setAttribute('aria-label', t('composer.removeImage', { n: i + 1 }));
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

// Asks that arrive while a reply is running (Alt+Enter in the address bar, "Ask about selection",
// the new-tab page's Ask AI, a starter chip) wait their turn instead of disappearing.
const queued = [];
function sendQueued() {
  const next = queued.shift();
  if (!next) return;
  next.notice.remove();
  ask(next.text, next.images);
}

function ask(text, images = []) {
  if (running) {
    const notice = append(Object.assign(document.createElement('div'), { className: 'notice queued', textContent: t('chat.queued', { text: text.length > 60 ? `${text.slice(0, 59)}…` : text || t('chat.image') }) }));
    queued.push({ text, images, notice });
    return;
  }
  // Nothing connected: show the setup card instead of sending a message that can only error.
  if (!modelReady) {
    if (!messages.querySelector('.msg')) { refreshSetup(); return; }
    append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('chat.setupNeeded') }));
    return;
  }
  const bubble = document.createElement('div');
  bubble.className = 'msg user';
  if (images.length) {
    const row = document.createElement('div');
    row.className = 'msg-images';
    for (const [i, a] of images.entries()) {
      const img = document.createElement('img');
      img.src = a.url;
      img.alt = t('chat.imageN', { n: i + 1 });
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
  read_page: () => t('tool.read_page'),
  screenshot: () => t('tool.screenshot'),
  navigate: (i) => t('tool.navigate', { url: i.url }),
  click: () => t('tool.click'),
  type_text: (i) => t('tool.type_text', { text: i.text }),
  press_key: (i) => t('tool.press_key', { key: i.key }),
  scroll: (i) => t('tool.scroll', { direction: i.direction }),
  go_back: () => t('tool.go_back'),
  list_tabs: () => t('tool.list_tabs'),
  open_tab: (i) => t('tool.open_tab', { url: i.url }),
  switch_tab: (i) => t('tool.switch_tab', { tab: i.tab_id }),
  wait: (i) => t('tool.wait', { seconds: i.seconds }),
  web_search: (i) => t('tool.web_search', { query: i.query ?? '' }),
  find: (i) => t('tool.find', { query: i.query ?? '' }),
  batch: (i) => t('tool.batch', { count: i.steps?.length || t('tool.batch.several') }),
  fill_form: () => t('tool.fill_form'),
  click_at: () => t('tool.click_at'),
  hover: () => t('tool.hover'),
  go_forward: () => t('tool.go_forward'),
  reload: () => t('tool.reload'),
  close_tab: (i) => t('tool.close_tab', { tab: i.tab_id }),
  group_tabs: (i) => t('tool.group_tabs', { name: i.name ?? '' }),
  ungroup_tabs: () => t('tool.ungroup_tabs'),
  read_urls: () => t('tool.read_urls'),
  run_script: () => t('tool.run_script'),
  wait_for: (i) => t('tool.wait_for', { text: i.text ?? '' }),
};

// Rendering a long reply's whole markdown on every streamed chunk grew slower and slower (the work
// is quadratic in its length), so a streaming reply redraws at most once per frame, and a very long
// one every 120 ms.
// The bubble keeps its own source (el.source), so a draw that lands after the reply moved on to a
// tool step still shows every character of this bubble.
function renderStreaming(el, source) {
  el.source = source;
  if (el.renderPending) return;
  el.renderPending = true;
  const draw = () => {
    if (!el.renderPending) return; // flushStreaming already drew it
    el.renderPending = false;
    el.innerHTML = window.renderMarkdown(settledMarkdown(el.source));
    moveWorkingToEnd();
    scrollToBottom();
  };
  if (source.length > 12000) setTimeout(draw, 120);
  else requestAnimationFrame(draw);
}

// The bubble's final draw, at once and with nothing held back, before a copy button or label goes in.
function flushStreaming(el) {
  if (!el || el.source === undefined || el.flushed) return;
  el.renderPending = false;
  el.flushed = true;
  el.innerHTML = window.renderMarkdown(el.source);
}

function endStream() {
  flushStreaming(turn?.text);
  turn?.text?.classList.remove('streaming');
}

window.assistant.onEvent((event) => {
  // An approval card answered or cancelled from an older run (after Stop or New chat) still has to
  // clear, or the toolbar's "waiting for approval" badge stayed on.
  if (event.type === 'approval_done') { resolveApproval(event.approvalId, event.ok); return; }
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
        details.innerHTML = '<summary></summary><div></div>';
        details.firstChild.textContent = t('chat.thinking');
        turn.thinking = append(details).querySelector('div');
      }
      turn.thinking.textContent += event.text;
      moveWorkingToEnd();
      break;
    }
    case 'text': {
      if (!turn.text) turn.text = append(Object.assign(document.createElement('div'), { className: 'msg assistant streaming' }));
      turn.textSource += event.text;
      renderStreaming(turn.text, turn.textSource);
      break;
    }
    case 'retry':
      // The turn is being asked again (see agent.js loop): drop what it had streamed so far.
      turn.text?.remove();
      turn.thinking?.closest('details')?.remove();
      turn.text = null;
      turn.textSource = '';
      turn.thinking = null;
      break;
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
      if (document.body.classList.contains('sidebar-hidden')) showSidebar(true); // a hidden sidebar left the task waiting with only a badge as a hint
      showApproval(event.approvalId, event.host, { action: event.action, title: event.title, query: event.query, args: event.args, tainted: event.tainted });
      moveWorkingToEnd();
      break;
    case 'notice': {
      const notice = append(Object.assign(document.createElement('div'), { className: 'notice', textContent: event.text }));
      if (event.action === 'continue') {
        const button = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: t('chat.continue') });
        button.onclick = () => { button.remove(); ask(t('chat.continuePrompt')); };
        notice.append(' ', button);
      }
      break;
    }
    case 'error': {
      const error = append(Object.assign(document.createElement('div'), { className: 'error', textContent: event.text }));
      if (event.action === 'settings') {
        const button = Object.assign(document.createElement('button'), { className: 'btn', textContent: t('chat.setupAi') });
        button.onclick = openAiSettings;
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
      if (event.undo) window.showRunUndo?.(append, event.undo); // [ai controls] extras.js
      turn = null;
      setRunning(false);
      setTimeout(sendQueued);
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
  flushStreaming(bubble);
  if (!bubble || !modelId || bubble.querySelector('.reply-model')) return;
  const option = [...$('model').options].find((o) => o.value === modelId);
  // From main's list, not the <optgroup>: a lone group is drawn without one (see loadModels).
  const group = modelGroups.get(modelId) ?? option?.parentElement?.label;
  // Local engines (Claude Code, Grok Build) already name themselves.
  const name = !option ? modelId
    : group === 'Claude' ? `Claude ${option.textContent}`
    : !group || /^Your .* account$/.test(group) ? option.textContent
    : `${group} · ${option.textContent}`;
  bubble.append(Object.assign(document.createElement('span'), { className: 'reply-model', textContent: name }));
}

// ---------- copy a reply ----------

const COPY_ICON = '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v.5"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>';

function finishReply(bubble, source) {
  flushStreaming(bubble);
  if (!bubble || !source || !source.trim() || bubble.querySelector('.reply-copy')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reply-copy';
  button.title = t('chat.copy');
  button.setAttribute('aria-label', t('chat.copy'));
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
      button.title = t('chat.copyFailed');
    }
  };
  bubble.append(button);
}

// ---------- auto-allow actions: the sidebar's AI acts on any site without asking ----------

let autoAllow = false;
function renderAutoAllow() {
  const button = $('auto-allow');
  button.setAttribute('aria-pressed', String(autoAllow));
  button.title = autoAllow
    ? t('sidebar.autoAllow.on')
    : t('sidebar.autoAllow.off');
}
async function setAutoAllow(on) {
  autoAllow = Boolean(await window.assistant.autoAllow?.(on));
  renderAutoAllow();
}
$('auto-allow').onclick = () => setAutoAllow(!autoAllow);
window.assistant.autoAllow?.().then((on) => { autoAllow = Boolean(on); renderAutoAllow(); });

// ---------- inline approval before Claude acts on a new site ----------

const approvals = new Map(); // approvalId -> { card, host }

// `action: 'open'`: the AI has read page content in this chat and wants to open a new site (which
// could carry that content there), or search for `query`; `action: 'script'`: it wants to run a
// script on a site after reading page content; anything else is the usual "interact with this site" card.
function showApproval(approvalId, host, { action, title: openTitle, query, args, tainted } = {}) {
  if (action === 'tool') return showToolApproval(approvalId, host, { title: openTitle, args, tainted });
  const card = document.createElement('div');
  card.className = 'approval';
  card.tabIndex = 0;
  card.setAttribute('role', 'group');
  const agentName = assistantIdentity?.name || t('approval.theAi');
  const opening = action === 'open';
  const scripting = action === 'script';
  const heading = opening
    ? openTitle || (host ? t('approval.open', { name: agentName, host }) : t('approval.openNew', { name: agentName }))
    : scripting ? openTitle || t('approval.script', { name: agentName, host })
      : t('approval.interact', { name: agentName, host });
  card.setAttribute('aria-label', heading);

  const title = document.createElement('p');
  title.className = 'approval-title';
  title.textContent = heading;
  const detail = document.createElement('p');
  detail.className = 'approval-detail';
  detail.textContent = query !== undefined
    ? t('approval.detail.search', { query, host })
    : opening ? t('approval.detail.open')
      : scripting ? t('approval.detail.script')
        : t('approval.detail.interact');

  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const deny = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: t('approval.deny') });
  const allow = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: t('approval.allow') });
  const answer = (ok) => {
    if (card.classList.contains('answered')) return;
    card.classList.add('answered');
    deny.disabled = true;
    allow.disabled = true;
    window.assistant.approve?.(approvalId, ok);
  };
  // Always allow: this one, and turns on auto-allow for every site (the bolt in the sidebar head).
  const always = Object.assign(document.createElement('button'), { type: 'button', className: 'btn approval-always', textContent: t('approval.always') });
  always.title = t('approval.always.title');
  deny.onclick = () => answer(false);
  allow.onclick = () => answer(true);
  always.onclick = () => { always.disabled = true; setAutoAllow(true); answer(true); };
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === card) { e.preventDefault(); answer(true); }
    else if (e.key === 'Escape') { e.preventDefault(); answer(false); }
  });

  actions.append(deny, always, allow);
  card.append(title, detail, actions);
  append(card);
  approvals.set(approvalId, { card, host });
  // Never focused for the user: Enter on the card means Allow, and a card that grabbed focus while
  // someone was typing a follow-up turned their Enter into an approval. Keyboard users Tab to it.
  scrollToBottom();
}

// A tool from an MCP server the user added (agent.js allowExternal): the card shows exactly what
// would be sent. "Always allow" is per tool and isn't offered once the chat has read page content.
function showToolApproval(approvalId, host, { title: heading, args, tainted }) {
  const card = document.createElement('div');
  card.className = 'approval approval-tool';
  card.tabIndex = 0;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', heading || `Use ${host}?`);
  const title = Object.assign(document.createElement('p'), { className: 'approval-title', textContent: heading || `Use ${host}?` });
  const detail = Object.assign(document.createElement('p'), {
    className: 'approval-detail',
    textContent: tainted
      ? 'It has read page content in this chat. Check that these details are what you want to send to this server:'
      : 'This server gets these details:',
  });
  const pre = Object.assign(document.createElement('pre'), { className: 'approval-args', textContent: args || '{}' });
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const deny = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: "Don't allow" });
  const allow = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: 'Allow once' });
  const always = tainted ? null : Object.assign(document.createElement('button'), { type: 'button', className: 'btn approval-always', textContent: 'Always allow this tool', title: 'Stop asking for this tool (it still asks after the AI reads a page). Change it in Settings → You and AI.' });
  const answer = (ok) => {
    if (card.classList.contains('answered')) return;
    card.classList.add('answered');
    for (const b of [deny, allow, always]) if (b) b.disabled = true;
    window.assistant.approve?.(approvalId, ok);
  };
  deny.onclick = () => answer(false);
  allow.onclick = () => answer(true);
  if (always) always.onclick = () => answer('always');
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === card) { e.preventDefault(); answer(true); }
    else if (e.key === 'Escape') { e.preventDefault(); answer(false); }
  });
  actions.append(...[deny, always, allow].filter(Boolean));
  card.append(title, detail, pre, actions);
  append(card);
  approvals.set(approvalId, { card, host, tool: true });
  scrollToBottom();
}

function resolveApproval(approvalId, ok) {
  const entry = approvals.get(approvalId);
  if (!entry) return;
  approvals.delete(approvalId);
  const { card, host, tool } = entry;
  card.className = ok ? 'approval resolved' : 'approval resolved denied';
  card.removeAttribute('tabindex');
  card.removeAttribute('role');
  card.removeAttribute('aria-label');
  card.textContent = tool ? (ok ? t('approval.allowedTool', { host }) : t('approval.deniedTool', { host })) : ok ? t('approval.allowed', { host }) : t('approval.denied', { host });
  if (document.activeElement === document.body) prompt.focus();
}

// ---------- chat restored from the last session ----------

// Also used by renderer/chats.js to show a chat picked from the history list.
function showHistory(items) {
  if (!Array.isArray(items) || !items.length || messages.querySelector('.msg')) return;
  for (const item of items) {
    const bubble = document.createElement('div');
    if (item.role === 'user') {
      bubble.className = 'msg user';
      const images = (item.images || []).filter((src) => typeof src === 'string' && src.startsWith('data:image/'));
      if (images.length) {
        const row = document.createElement('div');
        row.className = 'msg-images';
        images.forEach((src, i) => row.append(Object.assign(document.createElement('img'), { src, alt: t('chat.imageN', { n: i + 1 }) })));
        bubble.append(row);
      }
      if (item.text) bubble.append(document.createTextNode(item.text));
    } else if (item.role === 'assistant' && item.text) {
      if (item.steps) {
        const summary = document.createElement('div');
        summary.className = 'step done restored';
        summary.innerHTML = '<span class="step-detail"></span>';
        summary.firstChild.textContent = t(item.steps === 1 ? 'chat.usedActions.one' : 'chat.usedActions.other', { count: item.steps });
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
}
window.assistant.onHistory?.(({ items } = {}) => showHistory(items));

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

// Empties the sidebar for a new chat or another one from the history list (renderer/chats.js).
function clearChatView() {
  runId++;
  for (const id of [...approvals.keys()]) resolveApproval(id, false); // clears the toolbar badge too
  approvals.clear();
  for (const q of queued.splice(0)) q.notice.remove();
  messages.querySelectorAll(':scope > :not(#empty)').forEach((el) => el.remove());
  $('empty').hidden = false;
  turn = null;
  setRunning(false);
}
$('new-chat').onclick = () => {
  window.assistant.reset();
  clearChatView();
  window.chatList?.refreshUsage('');
  prompt.focus();
};

// Pause looping indicators (the live dot, the working line) while the window is in the background.
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
        text.textContent = event.active || event.remaining > 0 ? t('mcp.driving', { client: event.clientName }) : mcpPillText;
      }
      append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t(event.active ? 'mcp.connected' : 'mcp.disconnected', { client: event.clientName }) }));
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
      const vars = { client: event.clientName, host: event.host, query: event.query };
      if (title) title.textContent = t(event.query !== undefined ? 'mcp.approval.search' : event.action === 'open' ? 'mcp.approval.open' : event.action === 'script' ? 'mcp.approval.script' : 'mcp.approval.interact', vars);
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

// [settings] UI preferences set in lumen://settings.
{
  const applyPrefs = (p) => {
    if (!p) return;
    const root = document.documentElement;
    root.classList.toggle('pref-compact-tabs', Boolean(p.compactTabs));
    root.classList.toggle('pref-no-bookmark-button', p.showBookmarkButton === false);
    root.classList.toggle('pref-reduce-motion', Boolean(p.reduceMotion));
    root.classList.toggle('pref-focus-rings', Boolean(p.focusRings));
    accent = p.accent || null;
    applyAccent();
  };
  // [look] The accent color (Settings → Appearance), in the shades styles.css uses; it follows
  // light and dark mode.
  let accent = null;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const mix = (n, to, t) => Math.round(n + (to - n) * t);
  function applyAccent() {
    const style = document.documentElement.style;
    const hex = accent && (dark.matches ? accent.dark : accent.light);
    if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) { for (const v of ['--accent', '--accent-rgb', '--accent-bright', '--accent-deep', '--accent-soft']) style.removeProperty(v); return; }
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
    style.setProperty('--accent', hex);
    style.setProperty('--accent-rgb', `${r} ${g} ${b}`);
    style.setProperty('--accent-bright', `rgb(${mix(r, 255, 0.25)} ${mix(g, 255, 0.25)} ${mix(b, 255, 0.25)})`);
    style.setProperty('--accent-deep', `rgb(${mix(r, 0, 0.18)} ${mix(g, 0, 0.18)} ${mix(b, 0, 0.18)})`);
    style.setProperty('--accent-soft', `rgb(${r} ${g} ${b} / ${dark.matches ? 0.2 : 0.14})`);
  }
  dark.addEventListener('change', applyAccent);
  window.lumenPrefs?.get().then(applyPrefs).catch(() => {});
  window.lumenPrefs?.onChange(applyPrefs);
}
