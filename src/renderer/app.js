// ($ and the chat itself live in chat-core.js, loaded before this file.)
/* global snapshotArrival, freezeKeepAlive */ // renderer/snapshot-arrival.js and freeze-keepalive.js, loaded before this file

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

// innerHTML is only touched when the markup differs: tab updates call this on every state push, and a
// rewrite throws away and rebuilds the same icon nodes.
function setMarkup(el, html) {
  if (el.dataset.markup === html) return;
  el.dataset.markup = html;
  el.innerHTML = html;
}

// The indicator collapses to icon-only at narrow or zoomed widths, so it needs a name beyond its tooltip.
// It is a button: it opens the site's page info (connection, permissions, cookies: features/page-info.js).
function setSecurityName(el, name) {
  el.title = t('pageInfo.tooltip', { state: name });
  el.setAttribute('aria-label', name);
  el.setAttribute('role', 'button');
  el.setAttribute('aria-haspopup', 'menu');
  el.tabIndex = 0;
}

function showAddress() {
  const security = $('security');
  if (document.activeElement === address) return;
  address.value = /^https?:/.test(currentUrl) ? prettyUrl(currentUrl) : currentUrl;
  if (currentError || currentLumenPage) {
    security.hidden = true; // an error page (or Lumen's own reader/source page) has no connection to vouch for
  } else if (currentUrl.startsWith('https:') && currentSecurity === 'broken') {
    security.className = 'security danger';
    setMarkup(security, WARN + '<span>' + t('security.notSecureLabel').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]) + '</span>');
    setSecurityName(security, t('security.broken'));
    security.hidden = false;
  } else if (currentUrl.startsWith('https:') && currentSecurity === 'mixed') {
    security.className = 'security insecure';
    setMarkup(security, WARN);
    setSecurityName(security, t('security.mixed'));
    security.hidden = false;
  } else if (currentUrl.startsWith('https:')) {
    security.className = 'security';
    setMarkup(security, LOCK);
    setSecurityName(security, t('security.secure'));
    security.hidden = false;
  } else if (currentUrl.startsWith('http:')) {
    security.className = 'security insecure';
    security.dataset.markup = ''; // built by hand below: not what setMarkup last wrote
    security.innerHTML = WARN;
    security.append(Object.assign(document.createElement('span'), { textContent: t('security.notSecure') }));
    setSecurityName(security, t('security.notEncrypted'));
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

// A strip still sliding (a tab just closed, opened or dropped): finish that first, so what is measured is where
// the tabs actually are, and the drag's own transform isn't overridden by an animation.
const settleStripNow = () => { for (const a of $('tabs').getAnimations({ subtree: true })) { try { a.finish(); } catch { /* infinite: leave it */ } } };
function startTabDrag(e, el, id) {
  if (e.button !== 0 || e.target.closest('.tab-close, .tab-audio')) return;
  settleStripNow();
  const tabs = [...$('tabs').querySelectorAll('.tab')];
  drag = { el, id, startX: e.clientX, startY: e.clientY, into: e.clientX - el.getBoundingClientRect().left, dx: 0, moved: false, ids: tabs.map((t) => Number(t.dataset.id)), rects: tabs.map((t) => t.getBoundingClientRect()), from: tabs.indexOf(el) };
  drag.to = drag.from;
  el.setPointerCapture(e.pointerId);
  // Losing the pointer (another app or the system took it) cancels the drag: nothing moves on a guess.
  el.addEventListener('lostpointercapture', () => { if (drag?.el === el) endTabDrag({ type: 'lostcapture' }); }, { once: true });
  // Once the tab has left for a window of its own this page may lose the pointer, so the release and
  // Escape are also watched on the window (main.js has its own fallbacks: see "dragging a tab out").
  window.addEventListener('pointerup', endTabDrag, true);
  window.addEventListener('pointercancel', endTabDrag, true);
  window.addEventListener('keydown', dragKey, true);
  window.addEventListener('blur', dragBlur);
}
// A group label pressed: dragged along the strip it moves the whole group there (the group's tabs gather
// under it and a slot shows where it will land); pulled out of the strip, it takes the group to another
// window or a new one.
function startGroupDrag(e, label, groupId) {
  if (e.button !== 0 || !window.browser.dragTabStart || renamingGroup !== null) return;
  settleStripNow();
  const members = (lastTabState?.tabs || []).filter((t) => t.groupId === groupId).map((t) => t.id);
  if (!members.length) return;
  const lead = members.includes(lastTabState.activeId) ? lastTabState.activeId : members[0];
  const first = $('tabs').querySelector('.tab, .group-label');
  drag = { el: label, id: lead, startX: e.clientX, startY: e.clientY, into: e.clientX - label.getBoundingClientRect().left, labelInset: parseFloat(getComputedStyle(label).marginLeft) || 0, dx: 0, moved: false, ids: [], rects: [first.getBoundingClientRect()], from: 0, to: 0, groupId, members, labelRect: label.getBoundingClientRect() };
  label.setPointerCapture(e.pointerId);
  label.addEventListener('lostpointercapture', () => { if (drag?.el === label) endTabDrag({ type: 'lostcapture' }); }, { once: true });
  window.addEventListener('pointerup', endTabDrag, true);
  window.addEventListener('pointercancel', endTabDrag, true);
  window.addEventListener('keydown', dragKey, true);
  window.addEventListener('blur', dragBlur);
}
function moveGroupDrag(e) {
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
  if (!drag.moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
  if (!drag.moved) { drag.moved = true; hideHoverCard(); drag.el.classList.add('dragging'); $('tabs').classList.add('reordering'); }
  const lift = Math.sign(dy) * Math.min(12, Math.abs(dy) * 0.3);
  // Horizontal intent while the pointer is still inside the strip starts a reorder, even when it
  // drifted down first. (Requiring the vertical move to stay under 14px dropped the gesture: a
  // release inside the strip then did nothing, and continuing out tore the group off.) Tear-off
  // still wins once the pointer is actually outside the strip.
  // The group is every tab of the window: the label drags the window itself right away, like an only tab.
  const whole = drag.members.length >= (lastTabState?.tabs.length || 0);
  if (!drag.along && !whole && Math.abs(dx) > 12 && !draggedOut(e)) {
    // Along the strip: the label and its tabs fold away and the slot shows the group where it would land
    // (the same picture as any tab dragged over a strip).
    drag.along = true;
    drag.el.style.transform = '';
    // The slot takes the group's own place and size in the same frame the label and tabs fold away, so
    // nothing around it moves until the pointer does.
    const strip = $('tabs');
    const parts = [drag.el, ...drag.members.map((x) => strip.querySelector(`.tab[data-id="${x}"]`)).filter(Boolean)];
    drag.slotWidth = parts.reduce((w, el) => w + el.getBoundingClientRect().width, 0) + 4 * (parts.length - 1); // its real width: nothing beside it moves
    const order = (lastTabState?.tabs || []).filter((t) => !t.pinned);
    const lastMember = order.map((t) => t.id).lastIndexOf(drag.members[drag.members.length - 1]);
    drag.slotBefore = order.slice(lastMember + 1).find((t) => !drag.members.includes(t.id))?.id ?? null;
    drag.slotShown = true;
    drag.alongHome = drag.slotBefore;
    const group = (lastTabState?.groups || []).find((g) => g.id === drag.groupId);
    const lr = drag.el.getBoundingClientRect();
    showDropSlot({ beforeId: drag.slotBefore, width: drag.slotWidth, instant: true, ghost: false, tab: { title: group?.name || '', count: drag.members.length, group: group ? { name: group.name, color: group.color } : null } });
    gatherTabs(drag.members, null, null, false);
    // The label (with its count) follows the pointer, as a tab does; its tabs are folded into it.
    drag.el.style.left = `${lr.left}px`;
    drag.el.style.top = `${lr.top}px`;
    drag.el.style.width = `${lr.width}px`;
    drag.el.classList.add('floating');
    drag.labelLeft = lr.left;
  }
  if (drag.along) {
    const sr = $('tabs').getBoundingClientRect();
    drag.el.style.transform = `translate(${Math.max(sr.left - drag.labelLeft, Math.min(sr.right - drag.labelLeft - drag.el.offsetWidth, dx))}px, ${lift}px)`;
  }
  if (!drag.along) drag.el.style.transform = `translate(${Math.sign(dx) * Math.min(12, Math.abs(dx) * 0.3)}px, ${lift}px)`;
  drag.el.classList.toggle('tearing', !drag.along && Math.abs(dy) > 14);
  if (!drag.prepped && window.browser.dragTabPrep && nearEdge(e)) { drag.prepped = true; window.browser.dragTabPrep(drag.id); }
  if (!draggedOut(e) && !whole) {
    if (drag.along) {
      drag.lastX = e.clientX;
      groupRetarget(e.clientX);
      // Held near an edge of an overflowing strip, it scrolls on (and the slot follows), as a single tab does.
      const bar = $('tabs');
      const br = bar.getBoundingClientRect();
      drag.edge = bar.scrollWidth > bar.clientWidth + 1 ? (e.clientX < br.left + 28 ? -1 : e.clientX > br.right - 28 ? 1 : 0) : 0;
      if (drag.edge && !drag.edgeTimer) {
        const d = drag;
        const tick = () => { if (drag !== d || !d.edge || d.handed) { d.edgeTimer = 0; return; } bar.scrollLeft += 9 * d.edge; groupRetarget(d.lastX); d.edgeTimer = requestAnimationFrame(tick); };
        d.edgeTimer = requestAnimationFrame(tick);
      }
    }
    return;
  }
  drag.edge = 0;
  if (drag.edgeTimer) { cancelAnimationFrame(drag.edgeTimer); drag.edgeTimer = 0; }
  if (dropSlot) { closeSlot(dropSlot.el); dropSlot = null; } // on its way out of the strip: no slot here
  drag.handed = true;
  drag.group = drag.members;
  drag.single = (lastTabState?.tabs.length || 0) - drag.members.length < 1; // the whole window: it is what moves
  drag.el.style.transform = '';
  drag.el.classList.remove('tearing');
  if (drag.single) {
    $('tabs').querySelectorAll('.gathered').forEach((t) => t.classList.remove('gathered'));
    drag.el.classList.remove('dragging');
    $('tabs').classList.remove('reordering');
  } else {
    drag.el.classList.add('handed');
    for (const t of $('tabs').querySelectorAll('.tab')) if (drag.members.includes(Number(t.dataset.id))) t.classList.add('handed');
  }
  trackIndicator(320);
  // The label will be the first thing in the new strip. Its viewport left includes the strip's
  // scroll, which would open the window that far from the cursor; layout uses the unscrolled origin.
  const layout = tearOffLayout(drag.el, drag.members, { label: true });
  window.browser.dragTabStart(drag.id, { x: e.clientX, y: e.clientY, stripX: layout.origin + layout.labelInset + layout.into, pressY: drag.startY, ids: drag.members, group: drag.groupId, layout });
}
// A group dragged along its strip: the slot goes where it would land for pointer x.
function groupRetarget(x) {
  if (!drag?.along) return;
  const beforeId = groupDropBefore(x, drag.members);
  if (drag.slotShown && drag.slotBefore === beforeId) return;
  drag.slotShown = true;
  drag.slotBefore = beforeId;
  const group = (lastTabState?.groups || []).find((g) => g.id === drag.groupId);
  showDropSlot({ beforeId, width: drag.slotWidth, ghost: false, tab: { title: group?.name || '', count: drag.members.length, group: group ? { name: group.name, color: group.color } : null } });
}
// Where a group dragged along the strip would land: before the first other tab whose middle is right of
// the cursor, never inside another group (it goes after that group instead). null: at the end.
function groupDropBefore(x, members) {
  const order = (lastTabState?.tabs || []).filter((t) => !members.includes(t.id) && !t.pinned);
  const hit = stripTargets(members, false).find((t) => x < t.mid);
  let i = hit ? order.findIndex((t) => t.id === hit.id) : -1;
  if (i === -1) return null;
  while (i > 0 && i < order.length && order[i].groupId && order[i - 1].groupId === order[i].groupId) i++;
  return i < order.length ? order[i].id : null;
}
// Tabs travelling with the dragged one (a multi-selection, a group's tabs) fold into it: they give up
// their room, and the tabs beside them slide over (FLIP), leaving the dragged tab with a count.
function gatherTabs(ids, keep, extra = null, flip = true) {
  const strip = $('tabs');
  const all = [...strip.querySelectorAll('.tab, .group-label')];
  const before = new Map(all.map((el) => [el, el.getBoundingClientRect().left]));
  for (const t of strip.querySelectorAll('.tab')) if (t !== keep && ids.includes(Number(t.dataset.id))) t.classList.add('gathered');
  extra?.classList.add('gathered');
  if (flip && !motionReduced()) {
    for (const el of all) {
      if (el.classList.contains('gathered') || el === keep || el === drag?.el) continue;
      const d = before.get(el) - el.getBoundingClientRect().left;
      if (Math.abs(d) > 0.5) el.animate([{ translate: `${d}px 0` }, { translate: '0 0' }], { duration: 300, easing: SPRING_SMOOTH });
    }
  }
  trackIndicator(320);
}
// This window lost the focus mid-drag (Alt+Tab, the Windows key, another app popping up): the drag is
// cancelled, as Escape would, rather than left following a pointer that has gone elsewhere.
function dragBlur() {
  if (drag && !drag.single) endTabDrag({ type: 'lostcapture' });
}
function dragKey(e) {
  if (e.key === 'Escape' && drag) { e.preventDefault(); e.stopPropagation(); endTabDrag(e); }
}
// Where every tab and label is on screen now (transforms included), for settleFrom.
function measureStrip() {
  return new Map([...$('tabs').querySelectorAll('.tab, .group-label')].map((el) => [el, el.getBoundingClientRect()]));
}
// After the strip's DOM has been put in its new order: everything glides from where it was on screen to
// where it now sits (FLIP), so a drop settles into place instead of blinking or snapping back first.
// Tabs that had no width before (folded or held) grow in where they land.
function settleFrom(before) {
  if (motionReduced()) { placeIndicator(false); return; }
  for (const el of $('tabs').querySelectorAll('.tab, .group-label')) {
    const a = before.get(el);
    const b = el.getBoundingClientRect();
    if (!a || a.width < 1) { if (!el.classList.contains('arriving')) el.animate([{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: SPRING_SNAPPY }); continue; }
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 340, easing: SPRING_SMOOTH });
  }
  trackIndicator(360);
}
// A move this strip has already drawn, waiting for main to confirm it ('tab:dragdone'): updates wait
// meanwhile (the newest is kept), so a stale one can't put the tabs back where they were for a moment.
let awaitingMove = null;
function expectMove() {
  clearTimeout(awaitingMove);
  awaitingMove = setTimeout(moveConfirmed, 800);
}
function moveConfirmed() {
  if (!awaitingMove) return;
  clearTimeout(awaitingMove);
  awaitingMove = null;
  if (pendingState && !drag) { const state = pendingState; pendingState = null; renderTabsNow(state); }
}
let heldTab = null; // { id, ids, timer }: dropped tabs kept hidden in this strip until main has placed them
function holdDroppedTab(id, ids = [id]) {
  // A second drop while the first is still being placed: both stay hidden (the first mustn't flash back).
  if (heldTab) { clearTimeout(heldTab.timer); ids = [...new Set([...heldTab.ids, ...ids])]; }
  heldTab = { id, ids, timer: setTimeout(releaseHeldTab, 5000) };
  for (const x of ids) $('tabs').querySelector(`.tab[data-id="${x}"]`)?.classList.add('held');
}
function releaseHeldTab(quiet = false) {
  if (!heldTab) return;
  clearTimeout(heldTab.timer);
  heldTab = null;
  const shown = [...$('tabs').querySelectorAll('.held')];
  const landing = !quiet && landingSlot && shown.some((t) => t.classList.contains('tab')); // else they left for another window: the slot closes on its own
  const before = landing ? measureStrip() : null;
  shown.forEach((t) => t.classList.remove('held'));
  if (!landing) return;
  // Dropped back into this strip: the tabs take the slot that stayed open for them (renderTabs keeps it in
  // place until now). The slot is about as wide as what lands; any difference (a group's label, tabs of other
  // widths) is taken up by the neighbours gliding (FLIP) while the tabs grow in, rather than jumping.
  clearTimeout(landingSlot.timer);
  landingSlot.el.remove();
  landingSlot = null;
  settleFrom(before);
  const live = $('tab-live');
  const tabsShown = shown.filter((el) => el.classList.contains('tab'));
  if (live) live.textContent = tabsShown.length > 1 ? t('tabs.movedMany', { n: tabsShown.length }) : t('tabs.moved', { title: (lastTabState?.tabs || []).find((x) => String(x.id) === tabsShown[0]?.dataset.id)?.title || '' });
}
window.browser.onTabDragDone?.(() => { moveConfirmed(); releaseHeldTab(); });
window.browser.onTabDragAbort?.(() => { if (drag) endTabDrag({ type: 'lostcapture' }); });
// Tabs moved here from another window's tab menu: announced, and a multi-selection stays selected.
let selectAfterRender = null;
window.browser.onTabMovedHere?.((info) => {
  const ids = Array.isArray(info?.ids) ? info.ids.filter(Number.isInteger) : [];
  const live = $('tab-live');
  if (live && ids.length && !info.quiet) live.textContent = ids.length > 1 ? t('tabs.movedHereMany', { n: ids.length }) : t('tabs.movedHere', { title: String(info.title || '') });
  if (ids.length > 1) {
    if (ids.every((x) => (lastTabState?.tabs || []).some((t) => t.id === x))) setSelection(ids); // the tabs arrived first: select now
    else selectAfterRender = ids;
  }
});
// This window was just made for dragged tabs: say so to screen readers.
window.browser.onTabArrived?.((info) => {
  const live = $('tab-live');
  if (live) live.textContent = info?.count > 1 ? t('tabs.movedToNewWindowMany', { n: info.count }) : t('tabs.movedToNewWindow');
});
// A dragged tab is over this strip: the tabs part to open a tab-sized slot where it would land, as in
// Chrome and Safari. Moving along the strip closes the old slot while the new one opens, so the tabs
// glide rather than jump. When the tab then arrives here, it takes the slot's place (see animateTabs).
let dropSlot = null; // the open slot: { el, beforeId }
let landingSlot = null; // the slot a just-dropped tab is about to fill: { el, timer }
function trackIndicator(ms) {
  // The slot moves tabs without a re-render: keep the active tab's surface under it meanwhile.
  const end = performance.now() + ms;
  const step = () => { placeIndicator(false); if (performance.now() < end) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function closeSlot(el) {
  if (!el?.isConnected) return;
  if (motionReduced()) { el.remove(); return; }
  el.classList.remove('open');
  el.addEventListener('transitionend', () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 500);
}
// The inside of a drop slot: a tab's parts, drawn like one but never a real tab (no id, no events).
function createGhostTab(tab) {
  const el = document.createElement('div');
  el.className = 'tab-drop-ghost';
  const inner = Object.assign(document.createElement('div'), { className: 'tab-inner' });
  const urls = (Array.isArray(tab.favicons) ? tab.favicons : []).filter((u) => typeof u === 'string');
  let icon = globeIcon(tab.page || null);
  if (urls.length) {
    icon = Object.assign(document.createElement('img'), { className: 'tab-favicon', alt: '' });
    let i = 0;
    icon.onerror = () => { if (++i < urls.length) icon.src = urls[i]; else icon.replaceWith(globeIcon()); };
    icon.src = urls[0];
  }
  if (tab.group) {
    // A whole group: its colour and name, as its label shows them.
    el.classList.add('group');
    el.style.setProperty('--group-color', `var(--g-${String(tab.group.color || 'gray').replace(/[^a-z]/g, '')})`);
    inner.append(Object.assign(document.createElement('span'), { className: 'tab-drop-group-dot' }), Object.assign(document.createElement('span'), { className: 'tab-title', textContent: String(tab.group.name || '') }));
  } else {
    inner.append(icon, Object.assign(document.createElement('span'), { className: 'tab-title', textContent: String(tab.title || 'New Tab') }));
  }
  el.append(inner);
  return el;
}
// How wide a group's label is drawn with this name (measured once per name, off screen, as the strip draws it).
const labelWidths = new Map();
function groupLabelWidth(group) {
  const name = String(group?.name || '');
  if (labelWidths.has(name)) return labelWidths.get(name);
  const probe = Object.assign(document.createElement('div'), { className: 'group-label' });
  probe.append(Object.assign(document.createElement('span'), { className: 'group-name', textContent: name }), Object.assign(document.createElement('span'), { className: 'group-count', textContent: '9' }));
  Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', left: '-9999px' });
  $('tabs').append(probe);
  const w = Math.ceil(probe.getBoundingClientRect().width) + 4; // and the gap after it
  probe.remove();
  labelWidths.set(name, w);
  return w;
}
function dropSlotWidth() {
  // A group being reordered folds its tabs to nothing (.gathered). Averaging those in collapsed
  // the slot toward the minimum. Only tabs that still have their real width count; with none left
  // (the whole strip is the group) the slot is a resting tab.
  const tabs = [...$('tabs').querySelectorAll('.tab:not(.pinned):not(.handed):not(.held):not(.gathered)')];
  if (!tabs.length) return 200;
  return Math.round(Math.min(200, Math.max(72, tabs.reduce((sum, t) => sum + t.offsetWidth, 0) / tabs.length)));
}
function clearLandingSlot() {
  if (!landingSlot) return;
  clearTimeout(landingSlot.timer);
  closeSlot(landingSlot.el);
  landingSlot = null;
}
function showDropSlot(at) {
  const strip = $('tabs');
  if (!at) {
    if (!dropSlot) return;
    // Left open briefly: if the tab lands here, it arrives in this slot instead of the tabs closing up first.
    clearLandingSlot();
    const el = dropSlot.el;
    dropSlot = null;
    landingSlot = { el, timer: setTimeout(() => { if (landingSlot?.el === el) { landingSlot = null; closeSlot(el); trackIndicator(460); } }, 1200) }; // filled as soon as the tab arrives
    return;
  }
  clearLandingSlot();
  if (dropSlot && dropSlot.beforeId === at.beforeId && dropSlot.outside === Boolean(at.outside) && dropSlot.el.isConnected) return;
  let before = at.beforeId == null ? null : strip.querySelector(`.tab[data-id="${at.beforeId}"]`);
  // The tab it lands before isn't drawn (it is inside a collapsed group): the slot goes before that group's label.
  if (!before && at.beforeId != null) {
    const g = (lastTabState?.tabs || []).find((t) => t.id === at.beforeId)?.groupId;
    before = g ? strip.querySelector(`.group-label[data-group="${g}"]`) : null;
  }
  const pinnedEnd = [...strip.querySelectorAll('.tab.pinned')].pop();
  let ref = before || null;
  // Before a group's first tab means before the group: the slot goes ahead of its label, outside it —
  // unless it is the dragged tab's own group (put back at its start, it stays in). Tabs that are out on the
  // card or folded away don't count as neighbours.
  let label = ref?.classList.contains('tab') ? ref.previousElementSibling : null;
  while (label?.matches('.handed, .held, .gathered, .floating, .tab-drop-slot')) label = label.previousElementSibling;
  const refGroup = (lastTabState?.tabs || []).find((t) => t.id === at.beforeId)?.groupId;
  // A drag in this strip says which side of the label it means (`outside`); a tab from elsewhere lands outside.
  const beforeLabel = 'outside' in at ? Boolean(at.outside) : at.tab?.ownGroup !== refGroup;
  if (label?.classList.contains('group-label') && refGroup === Number(label.dataset.group) && beforeLabel) ref = label;
  if (dropSlot) closeSlot(dropSlot.el);
  const el = document.createElement('div');
  const pinned = Boolean(at.tab?.pinned);
  el.className = `tab-drop-slot${pinned ? ' pinned' : ''}`;
  el.setAttribute('aria-hidden', 'true');
  const count = Math.max(1, Number(at.tab?.count) || 1);
  const labelW = at.tab?.group ? groupLabelWidth(at.tab.group) : 0; // a group brings its label too
  const room = count * dropSlotWidth() + 4 * (count - 1) + labelW;
  const many = count === 1 && !labelW ? room : Math.min(strip.clientWidth / 2, room); // several tabs: their room, at most half the strip
  el.style.setProperty('--slot-w', `${at.width ? Math.round(at.width) : pinned ? 40 * count : many}px`);
  // The tab as it will be here: its icon and title (and how many tabs come with it). An in-strip
  // reorder passes ghost: false — the real tab is already following the pointer, and a second
  // picture of it in the gap would be a double image. The gap itself still opens, labels included.
  if (at.tab && at.ghost !== false) {
    const ghost = createGhostTab(at.tab);
    if (at.tab.count > 1) ghost.querySelector('.tab-inner').append(Object.assign(document.createElement('span'), { className: 'tab-drop-count', textContent: String(at.tab.count) }));
    if (at.tab.group) el.style.setProperty('--group-color', ghost.style.getPropertyValue('--group-color'));
    el.append(ghost);
  }
  // A pinned tab lands among the pinned ones; any other tab never goes in among them.
  const firstLoose = strip.querySelector('.tab:not(.pinned):not(.handed)');
  if (pinned && (!ref || !ref.classList.contains('pinned'))) strip.insertBefore(el, pinnedEnd ? pinnedEnd.nextSibling : firstLoose || null);
  else if (!pinned && ref && pinnedEnd && ref.classList.contains('pinned')) strip.insertBefore(el, pinnedEnd.nextSibling);
  else strip.insertBefore(el, ref);
  dropSlot = { el, beforeId: at.beforeId, outside: Boolean(at.outside) };
  // Inside a group (between two of its tabs, or right after its label): the slot takes the group's colour,
  // since dropping there joins it.
  const inside = !at.tab?.group && slotGroup(el, at.ghost === false ? at.tab?.ownGroup || null : null);
  const color = inside && (lastTabState?.groups || []).find((g) => g.id === inside)?.color;
  if (color) { el.classList.add('in-group'); el.style.setProperty('--group-color', `var(--g-${String(color).replace(/[^a-z]/g, '')})`); }
  // A group moved along its own strip: no ghost (its label follows the pointer), the slot in the group's colour.
  if (at.ghost === false && at.tab?.group) { el.classList.add('in-group'); el.style.setProperty('--group-color', `var(--g-${String(at.tab.group.color || 'gray').replace(/[^a-z]/g, '')})`); }
  // `instant`: opened already at full width, in the same frame the dragged thing leaves the flow, so the
  // tabs around it don't close up and then spring back open.
  if (motionReduced() || at.instant) {
    el.classList.add('open');
    if (at.instant) { el.classList.add('instant'); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('instant'))); }
  } else requestAnimationFrame(() => el.classList.add('open'));
  trackIndicator(460);
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
// Tabs dropped here from another window arrive invisible while the chip that carries them glides into place, then
// show as it fades (one picture of the tab at a time); a safety timer shows them whatever happens.
let arriving = new Set();
let arrivingTimer = 0;
const showArrived = () => {
  clearTimeout(arrivingTimer);
  arriving = new Set();
  for (const el of $('tabs').querySelectorAll('.tab.arriving, .group-label.arriving')) el.classList.remove('arriving');
};
window.browser.onTabArriving?.(({ ids } = {}) => {
  arriving = new Set((ids || []).map(Number));
  for (const id of arriving) $('tabs').querySelector(`.tab[data-id="${id}"]`)?.classList.add('arriving'); // already here (its own strip)
  markArrivingLabels();
  clearTimeout(arrivingTimer);
  arrivingTimer = setTimeout(showArrived, 700);
});
// A group whose every tab is arriving arrives with its label.
function markArrivingLabels() {
  if (!arriving.size) return;
  const byGroup = new Map();
  for (const t of lastTabState?.tabs || []) if (t.groupId) byGroup.set(t.groupId, [...(byGroup.get(t.groupId) || []), t.id]);
  for (const [g, ids] of byGroup) if (ids.every((id) => arriving.has(id))) $('tabs').querySelector(`.group-label[data-group="${g}"]`)?.classList.add('arriving');
}
window.browser.onTabLanded?.(() => showArrived());
// Where tabs `ids` sit (the first of them, as wide as all), or the slot kept open for them: for main's landing glide.
function landingRect(ids) {
  const strip = $('tabs');
  const want = new Set((ids || []).map(Number));
  const placed = (el) => el && !el.matches('.held, .gathered, .handed') && el.offsetWidth > 0;
  // The first id is the dragged tab: from it, the run of arriving tabs beside it (pinned ones may land elsewhere).
  let first = strip.querySelector(`.tab[data-id="${Number(ids?.[0])}"]`);
  if (!placed(first)) first = null;
  let last = first;
  if (first) {
    // Arriving tabs next to it, and arriving group labels among them (a merged window's groups come too).
    const joins = (el) => placed(el) && (want.has(Number(el.dataset.id)) || el.matches('.group-label.arriving'));
    while (joins(first.previousElementSibling)) first = first.previousElementSibling;
    while (joins(last.nextElementSibling)) last = last.nextElementSibling;
  }
  const el = first || landingSlot?.el || dropSlot?.el;
  if (!el) return null;
  clearTimeout(arrivingTimer); // measured: the chip is on its way, so the safety timer starts now
  arrivingTimer = setTimeout(showArrived, 600);
  const sr = strip.getBoundingClientRect();
  // offsetLeft/offsetWidth: where it is laid out, not where the landing animation's scale and lift draw it now.
  const x = sr.left + el.offsetLeft - strip.scrollLeft;
  const w = last && last !== el ? last.offsetLeft + last.offsetWidth - el.offsetLeft : el.offsetWidth;
  return { x, y: sr.top + el.offsetTop, w, h: el.offsetHeight };
}
window.landingRect = landingRect;
// A tab from another window held near an edge of this (overflowing) strip: it scrolls, as for a drag within it.
let dropEdge = 0;
let dropEdgeTimer = 0;
window.browser.onTabDropAt?.((at) => {
  // The drag was cancelled (Escape, a lost release): the slot just goes, no landing to wait for.
  if (at?.cancel) { dropEdge = 0; clearLandingSlot(); if (dropSlot) { closeSlot(dropSlot.el); dropSlot = null; trackIndicator(460); } return; }
  dropEdge = at?.edge || 0;
  if (dropEdge && !dropEdgeTimer) {
    const tick = () => { if (!dropEdge || !dropSlot) { dropEdgeTimer = 0; return; } $('tabs').scrollLeft += 9 * dropEdge; dropEdgeTimer = requestAnimationFrame(tick); };
    dropEdgeTimer = requestAnimationFrame(tick);
  }
  showDropSlot(at);
});

// Dragged this far outside the strip (or out of the window), releasing the tab hands it to main.js:
// into another window's strip if the cursor is over one, else into a new window of its own.
const TEAR_OFF_PX = 36;
const nearEdge = (e) => { const bar = $('tabs').getBoundingClientRect(); return e.clientY > bar.bottom + 26 || e.clientY < bar.top - 26 || e.clientX < 8 || e.clientX > window.innerWidth - 8; };
function draggedOut(e) {
  const bar = $('tabs').getBoundingClientRect();
  return e.clientY > bar.bottom + TEAR_OFF_PX || e.clientY < bar.top - TEAR_OFF_PX
    || e.clientX < -TEAR_OFF_PX / 2 || e.clientX > window.innerWidth + TEAR_OFF_PX / 2;
}

// How wide the tab strip can be in a window of this size: the bar, minus its padding and the
// buttons that sit beside the tabs. A new window of the same size has the same room.
function tabStripRoom() {
  const bar = $('tabstrip');
  const strip = $('tabs');
  if (!bar) return strip.clientWidth;
  const cs = getComputedStyle(bar);
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const gap = parseFloat(cs.columnGap || cs.gap) || 0;
  let others = 0;
  let count = 0;
  for (const el of bar.children) {
    if (el === strip) { count++; continue; }
    if (el.getBoundingClientRect().width > 0) { others += el.getBoundingClientRect().width; count++; }
  }
  return Math.max(80, bar.clientWidth - pad - others - gap * Math.max(0, count - 1));
}
// What main.js needs to open a new window with the grabbed point under the cursor. The strip's
// content start does not move when the strip scrolls (a tab's own left does, by scrollLeft).
// `items` are the tabs that will land in the new window, pinned first, so a grabbed tab that has
// others to its left is not placed as if it were the first.
function tearOffLayout(grabbedEl, movingIds, { label = false } = {}) {
  const strip = $('tabs');
  const box = strip.getBoundingClientRect();
  const css = getComputedStyle(strip);
  const origin = box.left + (parseFloat(css.borderLeftWidth) || 0) + (parseFloat(css.paddingLeft) || 0);
  const gap = parseFloat(css.columnGap || css.gap) || 0;
  const into = drag.into ?? (drag.startX - grabbedEl.getBoundingClientRect().left);
  const room = tabStripRoom();
  if (label) {
    // Measured at the press: once the label folds away its margin is cleared, which would
    // shift the new window by that much.
    const inset = Number.isFinite(drag.labelInset) ? drag.labelInset : (parseFloat(getComputedStyle(grabbedEl).marginLeft) || 0);
    return { origin, into, room, gap, labelInset: inset, items: [], index: 0 };
  }
  const moving = new Set(movingIds);
  const ordered = (lastTabState?.tabs || []).filter((t) => moving.has(t.id));
  const placed = [...ordered.filter((t) => t.pinned), ...ordered.filter((t) => !t.pinned)];
  const index = Math.max(0, placed.findIndex((t) => t.id === drag.id));
  return { origin, into, room, gap, labelInset: 0, items: placed.map((t) => ({ pinned: Boolean(t.pinned) })), index };
}
// Where a single tab dragged along the strip would land: before the first other tab of the same
// kind (pinned among pinned, the rest among the rest) whose middle is right of the cursor.
// null: at the end of that run. Group labels aren't tabs; the slot is placed around them.
// Where something dropped at viewport x would land: the tabs and group labels on show, in strip order,
// each as { id, mid } — a label stands for its group's first tab (so a collapsed group, which shows only
// its label, is a place to drop before too). `skip`: ids being dragged. `pinned`: only pinned tabs count
// (a pinned tab stays among them), else only loose tabs and labels.
function stripTargets(skip = [], pinned = false) {
  const tabsNow = lastTabState?.tabs || [];
  const out = [];
  for (const el of $('tabs').querySelectorAll('.tab, .group-label')) {
    if (el.matches('.floating, .gathered, .handed, .held')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    let id;
    let outside = false;
    if (el.classList.contains('group-label')) {
      if (pinned) continue;
      id = tabsNow.find((t) => t.groupId === Number(el.dataset.group) && !skip.includes(t.id))?.id;
      outside = true; // before the label: before the group, outside it
    } else {
      id = Number(el.dataset.id);
      if (skip.includes(id) || el.classList.contains('pinned') !== Boolean(pinned)) continue;
      // The one tab a collapsed group shows is part of that folded group: dropping "before" it would slip a tab
      // into the group out of sight. Its label is the place to drop before the group.
      const g = tabsNow.find((t) => t.id === id)?.groupId;
      if (g && (lastTabState?.groups || []).find((x) => x.id === g)?.collapsed) continue;
    }
    if (id != null) out.push({ id, mid: r.left + r.width / 2, outside });
  }
  return out;
}
// For main.js's hit-testing while another window's tab is dragged over this strip (stripGeometry).
function stripDropTargets() { return stripTargets([], false).concat(stripTargets([], true)).sort((a, b) => a.mid - b.mid); } // { id, mid, outside }
// { id, outside } (outside: before that tab's group label, out of the group), or null for the end.
function tabDropBefore(x, skip, pinned) {
  return stripTargets(skip, pinned).find((t) => x < t.mid) || null;
}
// The tab after `id` among the ones that can be dropped before (same pinned kind, not being dragged): where
// its slot opens when it first lifts out, so the strip doesn't change at all in that frame.
// The drop target right after `el` as the strip shows it ({ id, outside }, id null for the end): its own place,
// taken from what is drawn, so a tab alone on show in a collapsed group opens its slot exactly where it is.
function nextTarget(el, skip) {
  let n = el.nextElementSibling;
  while (n && (n.matches('.floating, .gathered, .handed, .held, .tab-drop-slot, .tab-ghost') || (n.classList.contains('tab') && skip.includes(Number(n.dataset.id))))) n = n.nextElementSibling;
  if (!n) return { id: null, outside: false };
  if (n.classList.contains('group-label')) {
    const id = (lastTabState?.tabs || []).find((t) => t.groupId === Number(n.dataset.group) && !skip.includes(t.id))?.id ?? null;
    return { id, outside: id != null };
  }
  return { id: Number(n.dataset.id), outside: false };
}
const targetKey = (t) => `${t?.id ?? 'end'}${t?.outside ? '<' : ''}`;
// The group a slot sits inside, as drawn (between two of its tabs, or right after its label), or null.
// `own`: the group the dragged tab(s) are in. For them the gap right after that group's last tab is still inside it
// (as in Chrome, a tab leaves its group only once it is dragged past a neighbour outside it).
function slotGroup(el, own = null) {
  const groupOf = (n, dir) => {
    while (n && n.matches('.handed, .held, .gathered, .floating, .tab-drop-slot')) n = n[dir];
    if (!n) return null;
    if (n.classList.contains('group-label')) return dir === 'previousElementSibling' ? Number(n.dataset.group) : null;
    return (lastTabState?.tabs || []).find((t) => t.id === Number(n.dataset.id))?.groupId || null;
  };
  const g = groupOf(el.previousElementSibling, 'previousElementSibling');
  if (g && g === groupOf(el.nextElementSibling, 'nextElementSibling')) return g;
  return own && g === own ? own : null;
}
// moveTab's index: where `id` goes in the full order once it has been taken out, so it lands
// before `beforeId` (or at the end).
function indexBefore(beforeId, id) {
  const order = (lastTabState?.tabs || []).map((t) => t.id).filter((x) => x !== id);
  if (beforeId == null) return order.length;
  const i = order.indexOf(beforeId);
  return i === -1 ? order.length : i;
}

// Past the threshold the tab goes to main.js, which moves it into a new window under the cursor (or
// drags this whole window if it is the only tab). The element stays (holding the pointer) but takes no room.
function handOffTabDrag(e) {
  if (dropSlot) { closeSlot(dropSlot.el); dropSlot = null; }
  drag.slotShown = false;
  drag.handed = true;
  // Out of the strip now: its edge scrolling and slot-following stop (main drives the drag from here).
  drag.edge = 0;
  if (drag.edgeTimer) { cancelAnimationFrame(drag.edgeTimer); drag.edgeTimer = 0; }
  drag.floated = false;
  // A multi-selection that includes the dragged tab goes with it (main.js moves them together).
  drag.group = selectedTabs.size > 1 && selectedTabs.has(drag.id) ? stripOrder().filter((x) => selectedTabs.has(x)) : [drag.id];
  // Every tab of the window going: main drags the window itself, which keeps showing its tabs.
  drag.single = (lastTabState?.tabs.length || 0) - drag.group.length < 1;
  drag.el.style.transform = '';
  drag.el.style.left = '';
  drag.el.style.top = '';
  drag.el.style.width = '';
  drag.el.classList.remove('floating');
  [...$('tabs').querySelectorAll('.tab')].forEach((t) => {
    t.style.transform = '';
    t.classList.remove('gathered');
    if (!drag.single && drag.group.includes(Number(t.dataset.id))) t.classList.add('handed');
  });
  if (drag.single) { drag.el.classList.remove('dragging'); $('tabs').classList.remove('reordering'); $('tabs').querySelectorAll('.tab-gather-count').forEach((c) => c.remove()); }
  drag.el.classList.remove('tearing');
  trackIndicator(320); // the tabs close up over the gap
  // x, y: the cursor in this window (it holds its place if the whole window is dragged). pressY:
  // where the tab was grabbed. layout: where that point will sit in the new strip, so the window
  // opens with it under the cursor even when this strip is scrolled or other tabs travel along.
  const layout = tearOffLayout(drag.el, drag.group);
  window.browser.dragTabStart?.(drag.id, { x: e.clientX, y: e.clientY, stripX: layout.origin + layout.into, pressY: drag.startY, ids: drag.group, layout });
}

function moveTabDrag(e) {
  if (drag?.handed) { window.browser.dragTabMove?.(); return; } // main moves the card (or window) with it
  if (!drag) return;
  if (drag.groupId != null) { moveGroupDrag(e); return; }
  drag.dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.moved && Math.abs(drag.dx) < 5 && Math.abs(dy) < 5) return;
  if (!drag.moved) {
    drag.moved = true;
    hideHoverCard();
    drag.el.classList.add('dragging');
    $('tabs').classList.add('reordering');
    // Part of a multi-selection: the selected tabs gather into this one and move along the strip together.
    if (selectedTabs.size > 1 && selectedTabs.has(drag.id)) {
      const was = drag.el.getBoundingClientRect().left;
      drag.gathered = stripOrder().filter((x) => selectedTabs.has(x));
      // The room they will take where they land: their widths and the gaps between them (at most half the strip).
      const widths = drag.gathered.map((x) => $('tabs').querySelector(`.tab[data-id="${x}"]`)?.getBoundingClientRect().width || 0);
      drag.slotW = Math.min($('tabs').clientWidth / 2, widths.reduce((a, b) => a + b, 0) + 4 * (widths.length - 1));
      gatherTabs(drag.gathered, drag.el);
      const tabs = [...$('tabs').querySelectorAll('.tab:not(.gathered)')];
      drag.ids = tabs.map((t) => Number(t.dataset.id));
      drag.rects = tabs.map((t) => t.getBoundingClientRect());
      drag.from = drag.to = tabs.indexOf(drag.el);
      drag.startX += drag.rects[drag.from].left - was; // it stays under the cursor
      drag.dx = e.clientX - drag.startX;
      drag.el.querySelector('.tab-inner')?.append(Object.assign(document.createElement('span'), { className: 'tab-drop-count tab-gather-count', textContent: String(drag.gathered.length) }));
    }
    // Every tab of the window is moving (its only tab, or all of them selected): the window itself follows the
    // pointer right away, like its title bar (as in Chrome), with the grabbed point staying under the cursor.
    if (window.browser.dragTabStart && (lastTabState?.tabs.length || 0) - (drag.gathered || [drag.id]).length < 1) { handOffTabDrag(e); return; }
  }
  const { rects, from } = drag;
  // Held within the strip's visible edges; near an edge an overflowing strip scrolls to reach more tabs.
  const bar = $('tabs');
  const br = bar.getBoundingClientRect();
  // Held near an edge of an overflowing strip, it keeps scrolling (not only while the mouse moves).
  drag.edge = bar.scrollWidth > bar.clientWidth + 1 ? (e.clientX < br.left + 28 ? -1 : e.clientX > br.right - 28 ? 1 : 0) : 0;
  if (drag.edge && !drag.edgeTimer) {
    const d = drag;
    // The strip moves under a still pointer, so the slot is worked out again each frame (as Chrome does).
    const tick = () => { if (drag !== d || !d.edge) { d.edgeTimer = 0; return; } bar.scrollLeft += 9 * d.edge; if (d.floated) retarget(d.lastX); d.edgeTimer = requestAnimationFrame(tick); };
    d.edgeTimer = requestAnimationFrame(tick);
  }
  // (A tab of a group may run a little past the strip's right end: that is how it leaves a group that ends the strip.)
  const dx = Math.max(br.left - rects[from].left, Math.min(br.right - rects[from].right + (drag.homeGroup ? rects[from].width * 0.6 : 0), drag.dx));
  // Pulled up or down, the tab follows with resistance, and lifts off as it nears the point where it comes out.
  const lift = Math.sign(dy) * Math.min(12, Math.abs(dy) * 0.3);
  drag.el.style.transform = `translate(${dx}px, ${lift}px)`;
  drag.el.classList.toggle('tearing', Math.abs(dy) > 14 && window.browser.dragTabStart !== undefined);
  // Heading out of the strip: main readies a window (and the drag card) so a drop outside shows at once.
  if (!drag.prepped && window.browser.dragTabPrep && nearEdge(e)) { drag.prepped = true; window.browser.dragTabPrep(drag.id); }
  if (window.browser.dragTabStart && draggedOut(e)) { handOffTabDrag(e); return; }
  // One tab or a gathered selection alike: the tab leaves the flow and follows the pointer, and a slot shows
  // where it (and the tabs folded into it) will land, group labels included.
  const skip = drag.gathered || [drag.id];
  const pinned = drag.el.classList.contains('pinned');
  if (!drag.floated) {
    const r = rects[from];
    // The slot opens at the tab's own place, already full width, in the same frame the tab lifts out.
    const home = nextTarget(drag.el, skip);
    drag.slotShown = true;
    drag.slotBefore = home.id;
    drag.slotKey = drag.homeKey = targetKey(home);
    // A selection spread over the strip is gathered by any drop, even at the dragged tab's own place.
    if (drag.gathered) {
      const order = (lastTabState?.tabs || []).map((t) => t.id);
      const at = drag.gathered.map((x) => order.indexOf(x));
      if (at.some((k, i) => i && k !== at[i - 1] + 1)) drag.homeKey = null;
    }
    // The group(s) the dragged tabs are in now: a drop at home that the slot shows outside it is a move out.
    const inGroups = new Set((drag.gathered || [drag.id]).map((x) => (lastTabState?.tabs || []).find((t) => t.id === x)?.groupId || null));
    drag.homeGroup = inGroups.size === 1 ? [...inGroups][0] : undefined;
    showDropSlot({ beforeId: home.id, outside: home.outside, ghost: false, width: drag.slotW || r.width, instant: true, tab: { pinned, ownGroup: drag.homeGroup || null } });
    drag.el.style.left = `${r.left}px`;
    drag.el.style.top = `${r.top}px`;
    drag.el.style.width = `${r.width}px`;
    drag.el.classList.add('floating');
    drag.floated = true;
    drag.groupColor0 = drag.el.style.getPropertyValue('--group-color');
  }
  drag.lastX = e.clientX;
  retarget(e.clientX);
}
// Where the floating tab (or selection) would land for pointer x: moves the slot there if that changed.
function retarget(x) {
  if (!drag) return;
  const skip = drag.gathered || [drag.id];
  const pinned = drag.el.classList.contains('pinned');
  const hit = tabDropBefore(x, skip, pinned);
  if (!drag.slotShown || drag.slotKey !== targetKey(hit)) {
    drag.slotShown = true;
    drag.slotBefore = hit?.id ?? null;
    drag.slotKey = targetKey(hit);
    const tab = (lastTabState?.tabs || []).find((t) => t.id === drag.id);
    showDropSlot({ beforeId: drag.slotBefore, outside: Boolean(hit?.outside), ghost: false, width: drag.slotW || drag.rects[drag.from].width, tab: tab ? { pinned: Boolean(tab.pinned), ownGroup: ownFor() } : { pinned } });
  }
  // Right after its own group, the tab stays in it until it is pulled clearly past the group's last tab (as in
  // Chrome): then it leaves the group in place, the slot's tint and the tab's group colour going with it.
  const prev = dropSlot?.el ? edgeBefore(dropSlot.el) : null;
  const freeLeft = drag.rects[drag.from].left + (x - drag.startX); // where the pointer puts the tab, unclamped
  const leaving = Boolean(drag.homeGroup && prev && freeLeft > prev.getBoundingClientRect().right + Math.max(16, drag.rects[drag.from].width / 2));
  if (leaving !== Boolean(drag.leaving)) { drag.leaving = leaving; tintSlot(); }
  const staying = dropSlot?.el ? slotGroup(dropSlot.el, ownFor()) : null;
  if (drag.homeGroup && staying !== drag.homeGroup) drag.el.style.setProperty('--group-color', 'transparent');
  else if (drag.groupColor0) drag.el.style.setProperty('--group-color', drag.groupColor0);
  else drag.el.style.removeProperty('--group-color');
}
// The group a drag's own tabs still count as in at its trailing edge: theirs, unless being pulled out past it.
const ownFor = () => (drag && !drag.leaving ? drag.homeGroup || null : null);
// The last drawn tab before a slot (skipping what is folded away), if it is one of the dragged tab's own group.
function edgeBefore(el) {
  let n = el.previousElementSibling;
  while (n && n.matches('.handed, .held, .gathered, .floating, .tab-drop-slot')) n = n.previousElementSibling;
  if (!n?.classList.contains('tab')) return null;
  return (lastTabState?.tabs || []).find((t) => t.id === Number(n.dataset.id))?.groupId === drag?.homeGroup ? n : null;
}
// The open slot's group tint, again (after `leaving` changed): inside a group, or not.
function tintSlot() {
  const el = dropSlot?.el;
  if (!el) return;
  const g = slotGroup(el, ownFor());
  const color = g && (lastTabState?.groups || []).find((x) => x.id === g)?.color;
  el.classList.toggle('in-group', Boolean(color));
  if (color) el.style.setProperty('--group-color', `var(--g-${String(color).replace(/[^a-z]/g, '')})`);
  else el.style.removeProperty('--group-color');
}

function endTabDrag(e) {
  if (!drag) return;
  const { moved, from, id, handed, group, groupId, el: dragEl, gathered, along, slotBefore, slotShown, members, single, slotKey, homeKey, alongHome } = drag;
  // Escape, a cancelled pointer or a lost one: nothing moves.
  const escaped = e?.type === 'keydown' || e?.type === 'pointercancel' || e?.type === 'lostcapture';
  const fromIndex = (lastTabState?.tabs || []).findIndex((t) => t.id === id);
  const toIndex = slotShown ? indexBefore(slotBefore ?? null, id) : from;
  // A single tab released over a different slot lands there. The same slot it already occupied is
  // not a move (nothing is marked as placed by hand).
  // Released at its own place (the slot never left it): nothing moves, nothing is marked as placed by hand.
  const sameSpot = along ? (slotBefore ?? null) === (alongHome ?? null)
    : Boolean(homeKey) && slotKey === homeKey && (drag.homeGroup === undefined || (dropSlot?.el?.isConnected ? slotGroup(dropSlot.el, ownFor()) : null) === drag.homeGroup); // (spanning groups: at home, nothing changes)
  const ownGroup = ownFor();
  if (drag.groupColor0 !== undefined) { if (drag.groupColor0) dragEl.style.setProperty('--group-color', drag.groupColor0); else dragEl.style.removeProperty('--group-color'); } // its group colour back as it was
  const slotMove = moved && !handed && !escaped && slotShown && !gathered && !along && fromIndex !== -1 && !sameSpot;
  const floated = drag.floated;
  // Anything lifted out of the flow settles by FLIP: into the slot (a move), or back home (Escape, or let
  // go where it started), from where it was on screen.
  const settling = moved && !handed && (floated || along);
  const before = settling ? measureStrip() : null; // where things are on screen, before they are put in place
  drag = null;
  window.removeEventListener('pointerup', endTabDrag, true);
  window.removeEventListener('pointercancel', endTabDrag, true);
  window.removeEventListener('keydown', dragKey, true);
  window.removeEventListener('blur', dragBlur);
  $('tabs').classList.remove('reordering');
  $('tabs').querySelectorAll('.tab-gather-count').forEach((c) => c.remove());
  const blockMove = moved && !handed && !escaped && (gathered || along) && !sameSpot; // released at its own place: everything unfolds where it was
  if (dropSlot && !settling) { closeSlot(dropSlot.el); dropSlot = null; trackIndicator(460); }
  [...$('tabs').children].forEach((t) => {
    t.style.transform = '';
    if (t === dragEl) { t.style.left = ''; t.style.top = ''; t.style.width = ''; }
    t.classList.remove('dragging', 'tearing', 'handed', 'floating');
    if (!blockMove) t.classList.remove('gathered');
  });
  // Cancelled after it left the strip: the tabs open back up for it rather than popping in.
  if (handed && escaped) { const live = $('tab-live'); if (live) live.textContent = t('tabs.moveCancelled'); }
  if (handed && escaped && !single && !motionReduced()) {
    const back = [...$('tabs').querySelectorAll('.tab, .group-label')].filter((t) => (group || []).includes(Number(t.dataset.id)) || t === dragEl);
    back.forEach((t) => { t.classList.add('handed', 'returning'); void t.offsetWidth; t.classList.remove('handed'); });
    setTimeout(() => back.forEach((t) => t.classList.remove('returning')), 340);
    trackIndicator(340);
  }
  // Released outside the strip: the tab stays hidden until main has put it where it was dropped
  // ('tab:dragdone'), so it doesn't flash back here first. Escape shows it again at once.
  if (handed && !escaped && !single) { holdDroppedTab(id, group); if (groupId != null) dragEl.classList.add('held'); }
  let settled = false;
  if (moved) {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (handed) {
      if (escaped) window.browser.dragTabCancel?.(); else window.browser.dragTabEnd?.();
    } else if (escaped) {
      // Escape before the tab left the strip: it stays where it was.
    } else if (along && !sameSpot) {
      // A group dragged along its strip: its label and tabs take the slot's place, and glide there.
      const strip = $('tabs');
      const at = dropSlot?.el?.isConnected ? dropSlot.el : null;
      for (const el of [dragEl, ...members.map((x) => strip.querySelector(`.tab[data-id="${x}"]`))]) if (el) { el.classList.remove('gathered'); strip.insertBefore(el, at); }
      at?.remove();
      dropSlot = null;
      settleFrom(before);
      settled = true;
      expectMove();
      window.browser.moveTabs?.(members, slotBefore ?? null, groupId);
    } else if (gathered && floated && !sameSpot) {
      // A multi-selection: the tabs land together in the slot, gliding from where they were on screen, in
      // the group the slot showed (its tint), or out of any.
      const strip = $('tabs');
      const at = dropSlot?.el?.isConnected ? dropSlot.el : null;
      const join = at ? slotGroup(at, ownGroup) : null;
      for (const x of gathered) { const el = strip.querySelector(`.tab[data-id="${x}"]`); if (el) { el.classList.remove('gathered'); strip.insertBefore(el, at); } }
      at?.remove();
      dropSlot = null;
      settleFrom(before);
      settled = true;
      expectMove();
      window.browser.moveTabs?.(gathered, slotBefore ?? null, null, join);
    } else if (slotMove) {
      // The tab drops into the slot from where it floated, staying visible; main then confirms the order.
      const at = dropSlot?.el?.isConnected ? dropSlot.el : null;
      const join = at ? slotGroup(at, ownGroup) : null; // exactly the group the slot showed it joining (or none)
      if (at) { at.parentNode.insertBefore(dragEl, at); at.remove(); }
      dropSlot = null;
      settleFrom(before);
      settled = true;
      expectMove();
      if (dragEl.classList.contains('pinned')) window.browser.moveTab?.(id, toIndex, true);
      else window.browser.moveTabs?.([id], slotBefore ?? null, null, join);
    }
  }
  // A reorder by mouse is announced as a keyboard move would be.
  if (settled) {
    const live = $('tab-live');
    const moved1 = (lastTabState?.tabs || []).find((t) => t.id === id);
    if (live) live.textContent = gathered?.length > 1 || along ? t('tabs.movedMany', { n: (along ? members : gathered).length }) : t('tabs.moved', { title: moved1?.title || '' });
  }
  // Escape, or let go where it started: the slot goes and the tab glides back home (it never left its
  // place in the DOM), the tabs around it closing up from where they were.
  if (settling && !settled) {
    dropSlot?.el?.remove();
    dropSlot = null;
    settleFrom(before);
  }
  if (pendingState) {
    const state = pendingState;
    pendingState = null;
    renderTabsNow(state);
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
// `landed`: the tabs just dropped into this strip, filling the slot that was open for them.
function animateTabs(before, container, landed = new Set()) {
  const animate = tabsRendered && !motionReduced();
  const seen = new Set();
  for (const el of container.querySelectorAll('.tab, .group-label')) {
    seen.add(el.dataset.id);
    if (!animate) continue;
    const prev = before.get(el.dataset.id);
    if (landed.has(el)) {
      el.animate([{ opacity: 0.4, transform: 'translateY(-4px) scale(0.94)' }, { opacity: 1, transform: 'none' }], { duration: 360, easing: SPRING_SNAPPY });
    } else if (prev) {
      const dx = prev.rect.left - el.getBoundingClientRect().left;
      if (Math.abs(dx) > 0.5) el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 420, easing: SPRING_SMOOTH });
    } else if (el.classList.contains('group-label')) {
      // A new group's chip takes its room in the strip at once while the tabs around it are still sliding in from where they were: it stays
      // invisible (and under them) until they have mostly settled, then fades in, so it never overlaps a tab's icon mid-slide.
      el.style.zIndex = '0';
      const fade = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 260, easing: 'ease-out', fill: 'backwards' });
      fade.finished.then(() => { el.style.zIndex = ''; }, () => { el.style.zIndex = ''; });
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
    label.onclick = () => { if (!suppressClick) window.browser.toggleGroup(group.id); };
    // Pulled out of the strip, a label takes its whole group with it (to another window, or a new one).
    label.addEventListener('pointerdown', (e) => startGroupDrag(e, label, group.id));
    label.addEventListener('pointermove', moveTabDrag);
    label.addEventListener('pointerup', endTabDrag);
    label.addEventListener('pointercancel', endTabDrag);
    label.oncontextmenu = (e) => { e.preventDefault(); window.browser.groupMenu(group.id, { x: e.clientX, y: e.clientY }); };
  }
  label.className = 'group-label' + (group.collapsed ? ' collapsed' : '') + (crowded === 'dot' ? ' dot' : crowded ? ' crowded' : '') + (label.classList.contains('held') && heldTab ? ' held' : '')
    + (drag?.handed && !drag.single && drag.groupId === group.id ? ' handed' : '')
    + (arriving.size && (lastTabState?.tabs || []).filter((t) => t.groupId === group.id).every((t) => arriving.has(t.id)) ? ' arriving' : '');
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
  const chatMark = Object.assign(document.createElement('span'), { className: 'tab-chat-mark' }); // [chat per tab] updateTabEl
  chatMark.setAttribute('aria-hidden', 'true');
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
  // [ai manners] a tab the AI opened: a small sparkle after its title (updateTabEl; styles.css .tab-ai-mark)
  const aiMark = Object.assign(document.createElement('span'), { className: 'tab-ai-mark' });
  aiMark.setAttribute('aria-hidden', 'true');
  aiMark.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1l1.2 3.8L11 6 7.2 7.2 6 11 4.8 7.2 1 6l3.8-1.2z"/></svg>';
  inner.append(globeIcon(), chatMark, title, aiMark, close);
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

// [chat per tab] The glyph for each state (styles.css .tab-chat-mark): a spinner, a ring, a check, an exclamation mark.
const CHAT_MARKS = {
  running: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="2"/><path class="cm-spin" d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><g class="cm-still"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="6" cy="6" r="2" fill="currentColor"/></g></svg>',
  waiting: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  done: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle class="cm-on" cx="6" cy="6" r="6"/><path class="cm-glyph" d="M3.4 6.2l1.8 1.8 3.4-3.8"/></svg>',
  approval: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle class="cm-on" cx="6" cy="6" r="6"/><path class="cm-glyph" d="M6 3v3.4M6 8.7v.1"/></svg>',
};
function updateTabEl(el, tab, group, activeId) {
  const active = tab.id === activeId;
  el.className = 'tab' + (heldTab?.ids.includes(tab.id) ? ' held' : '') + (drag?.handed && !drag.single && drag.group?.includes(tab.id) ? ' handed' : '') + (active ? ' active' : '') + (group ? ' grouped' : '') + (tab.sleeping ? ' sleeping' : '') + (tab.pinned ? ' pinned' : '') + (tab.alert ? ' alert' : '') + (tab.aiReading ? ' ai-reading' : '') + (tab.chat ? ` chat-${tab.chat}` : '')
    + (selectedTabs.has(tab.id) && !active ? ' selected' : '') + (arriving.has(tab.id) ? ' arriving' : '');
  if (group) el.style.setProperty('--group-color', `var(--g-${group.color})`);
  else el.style.removeProperty('--group-color');
  el.setAttribute('aria-selected', String(active));
  // No title tooltip: the hover card (below) shows the title, as in Chrome, and the two would overlap.
  const chatNote = tab.chat ? { running: t('tabs.chat.running'), waiting: t('tabs.chat.waiting'), approval: t('tabs.chat.approval'), done: t('tabs.chat.done') }[tab.chat] : '';
  el.setAttribute('aria-label', [tab.aiReading ? `${tab.title} (AI is reading)` : tab.title, chatNote, tab.aiOpened ? t('tabs.aiOpened') : ''].filter(Boolean).join(', '));
  el.classList.toggle('ai-opened', Boolean(tab.aiOpened)); // [ai manners]
  el.dataset.chat = tab.chat || '';
  const chatMark = el.querySelector('.tab-chat-mark');
  if (chatMark && chatMark.dataset.state !== (tab.chat || '')) {
    chatMark.dataset.state = tab.chat || '';
    chatMark.className = `tab-chat-mark${tab.chat ? ` ${tab.chat === 'approval' ? 'needs-ok' : tab.chat}` : ''}`;
    chatMark.innerHTML = CHAT_MARKS[tab.chat] || '';
  }
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
      renderTabsNow(held);
    }
  }, 0);
}
$('tabs').addEventListener('pointerdown', () => {
  stripPressed = true;
  lastLayoutSig = null; // a press can become a drag that moves tabs: the next update measures

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
      renderTabsNow(held);
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
  const r = window.tabSelection.selectionAfterClick({
    order: stripOrder(), selected: [...selectedTabs], anchorId: selectionAnchor, activeId: lastTabState?.activeId, id,
    shift: e.shiftKey, toggle: isMac ? e.metaKey : e.ctrlKey,
  });
  selectionAnchor = r.anchor;
  setSelection(r.selection);
  if (r.activate != null) window.browser.switchTab(r.activate);
}

// Escape ends the selection (when the strip, not a page, has the keyboard).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectedTabs.size && !drag) setSelection([]);
});

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
  hostEl.textContent = tab.isolated && host ? `${host} · AI research: no cookies or logins` : host; // opened by the AI in its own empty session
  if (tab.aiOpened) hostEl.textContent = [hostEl.textContent, t('tabs.aiOpened')].filter(Boolean).join(' · '); // [ai manners]
  hostEl.hidden = !host && !tab.aiOpened;
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
// busy: true (grouping on this computer), 'refine' (the groups are shown, the AI is refining them: a click cancels), false.
const showOrganizing = (busy) => {
  organizeBtn.classList.toggle('busy', Boolean(busy));
  organizeBtn.disabled = busy === true;
  organizeBtn.querySelector('span').textContent = busy === 'refine' ? t('tabs.refining') : busy ? t('tabs.organizing') : t('tabs.organize');
};
// The click shows "Organizing…" (and disables the button) at once, not after main's round trip: no dead click, no double trigger.
// While the AI refines, a click cancels (main decides); main's own 'organizing' messages then take over.
let organizeGroupsBefore = null; // the groups there were when Organize was clicked: the ones after it that are not in it are the new ones (the toast names them)
organizeBtn.onclick = () => {
  if (organizeBtn.disabled) return;
  organizeGroupsBefore = new Set(((queuedTabState || lastTabState)?.groups || []).map((g) => g.id));
  if (!organizeBtn.classList.contains('busy')) showOrganizing(true);
  window.browser.organizeTabs();
};
window.browser.onOrganizing?.(showOrganizing);
// "Organized (no AI needed)", "Grouped your loose tabs while you were away": a short note with Undo.
window.browser.onOrganizeNote?.(({ text, undo, ttl, undoLabel, undoTitle, aiUndo }) => {
  document.querySelector('.organize-note')?.remove();
  const note = Object.assign(document.createElement('div'), { className: 'organize-note', role: 'status' });
  const words = Object.assign(document.createElement('span'), { className: 'organize-note-text', textContent: text });
  note.append(words);
  // An organize's note says what it made: "Organized: Nursing, Maui trip, Recipes +3 · 6 loose" (names clipped by the CSS to fit; the full text is the tooltip).
  if (undo && !undoLabel) {
    const summary = () => {
      const state = queuedTabState || lastTabState;
      if (!state || !(state.groups || []).length) return;
      const before = organizeGroupsBefore;
      const all = state.groups;
      const fresh = before ? all.filter((g) => !before.has(g.id)) : all;
      const names = (fresh.length ? fresh : all).map((g) => g.name).filter(Boolean);
      const said = /(\d+) tabs? left loose/.exec(text); // main counts the tabs it could have grouped (not the new-tab page, say)
      const loose = said ? Number(said[1]) : state.tabs.filter((x) => !x.groupId && !x.pinned).length;
      const lead = /^Grouped/.test(text) ? 'Grouped' : t('organize.local');
      const looseWord = t('organize.noteLoose', { count: loose });
      // "Organized: Nursing, Maui trip +3 · 6 loose": at most two names, whole (a name that does not fit is dropped into "+N", never cut mid-word);
      // only the names part ever clips (an ellipsis, for one name wider than the toast), so the "+N", the loose count and Undo always show.
      const part = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
      const build = (count) => {
        const shown = names.slice(0, count);
        const rest = names.length - shown.length;
        words.replaceChildren(part('organize-note-lead', `${lead}: `), part('organize-note-names', shown.join(', ')), ...(rest ? [part('organize-note-more', ` +${rest}`)] : []), ...(loose ? [part('organize-note-loose', ` · ${looseWord === 'organize.noteLoose' ? `${loose} loose` : looseWord}`)] : []));
      };
      const fit = () => {
        for (let count = Math.min(2, names.length); count >= 1; count--) {
          build(count);
          const box = words.querySelector('.organize-note-names');
          if (!note.isConnected || box.scrollWidth <= box.clientWidth + 1) return; // fits (or not on screen yet: measured again once it is)
        }
      };
      build(Math.min(2, names.length));
      summary.fit = fit;
      note.title = `${text}\n${names.join(', ')}`; // the full list, and what main said (which says whether an AI helped)
    };
    summary();
    requestAnimationFrame(() => { if (note.isConnected) summary.fit?.(); }); // measured once it is in the strip
    setTimeout(() => { if (note.isConnected) { summary(); summary.fit?.(); } }, 200); // the tab state with the new groups may arrive just after the note
  }
  if (undo) {
    note.append(Object.assign(document.createElement('button'), { textContent: undoLabel || t('organize.undo'), ...(undoTitle ? { title: undoTitle } : {}), onclick: () => { if (aiUndo) window.browser.undoAiClose?.(aiUndo); else window.browser.undoOrganize(); note.remove(); } })); // ([ai manners] a close of the AI's tabs undoes itself) // (a merge's note brings its own wording)
  }
  organizeBtn.after(note); // in the strip's own row: web pages cover everything below it
  setTimeout(() => note.remove(), Number.isFinite(ttl) ? ttl : 9000); // main's undo window is the same length as the note's life
});

// State pushes arrive in bursts (a page loading fires title, favicon and loading updates back to back):
// they are coalesced into one render per frame, the latest state winning.
let queuedTabState = null;
let tabsFrame = 0;
function renderTabs(state) {
  queuedTabState = state;
  if (tabsFrame) return;
  tabsFrame = requestAnimationFrame(() => {
    tabsFrame = 0;
    const next = queuedTabState;
    queuedTabState = null;
    if (next) renderTabsNow(next);
  });
}
// What decides where tabs sit and how wide they are. While it is unchanged, an update is only titles,
// icons, loading flags and the like: those are patched in place, with no measuring and no FLIP.
let lastLayoutSig = null;
function layoutSig(state) {
  const groups = (state.groups || []).map((g) => `${g.id}:${g.name}:${g.color}:${g.collapsed ? 1 : 0}`).join('|');
  const tabs = state.tabs.map((x) => `${x.id}.${x.groupId || 0}.${x.pinned ? 1 : 0}.${x.audible || x.muted ? 1 : 0}.${x.sleeping ? 1 : 0}.${aiHiddenTab(x, state) ? 1 : 0}`).join(',');
  return `${state.activeId}#${groups}#${tabs}`;
}

// [ai manners] The sidebar's toggle (ui-prefs.js sets window.lumenHideAiTabs): the tabs the AI opened are left out of the strip, except the one
// in front (and one being dragged), and one playing sound (its speaker button would vanish), so nothing you are using vanishes. They stay open; the toggle shows how many are out of sight.
function aiHiddenTab(tab, state) {
  return window.lumenHideAiTabs === true && Boolean(tab.aiOpened) && !tab.audible && tab.id !== state.activeId && drag?.id !== tab.id && !drag?.group?.includes(tab.id);
}
const hideAiButton = $('hide-ai-tabs');
// What the toggle reports, counted from the same rule the strip draws by: `hidden` tabs are out of the strip; `shown` are the AI's tabs that are
// in it anyway (the one in front, one playing sound) while the toggle is on. A tab is in exactly one of the two, so the button never says
// "hidden" about a tab the strip is showing, and never counts a shown tab as hidden.
function hideAiSummary(state) {
  const on = window.lumenHideAiTabs === true;
  const ai = (state?.tabs || []).filter((x) => x.aiOpened);
  const hidden = ai.filter((x) => aiHiddenTab(x, state)).length;
  return { on, total: ai.length, hidden, shown: on ? ai.length - hidden : 0 };
}
function syncHideAiToggle(state) {
  if (!hideAiButton) return;
  const { on, total, hidden: out, shown } = hideAiSummary(state);
  const count = on ? out : total;
  hideAiButton.hidden = !on && total === 0; // nothing to hide: no button (it stays while the toggle is on, so it can be turned off)
  hideAiButton.setAttribute('aria-pressed', String(on));
  const plural = (n) => (n === 1 ? 'one' : 'other');
  const label = !on ? t(`sidebar.hideAiTabs.off.${plural(total)}`, { count: total })
    : out > 0 && shown > 0 ? t(`sidebar.hideAiTabs.more.${plural(out)}`, { count: out })
      : out > 0 ? t(`sidebar.hideAiTabs.on.${plural(out)}`, { count: out })
        : shown > 0 ? t(`sidebar.hideAiTabs.inView.${plural(shown)}`, { count: shown })
          : t('sidebar.hideAiTabs.on.none');
  hideAiButton.title = label;
  const badge = $('hide-ai-tabs-count');
  // While the toggle is hiding or sparing tabs the button says so in words ("2 hidden", "2 more hidden" beside the AI tab in front, "1 in view"), not just with a number:
  // nothing in the strip says tabs went missing otherwise
  const chip = $('hide-ai-tabs-label');
  const words = on && (out > 0 || shown > 0);
  chip.hidden = !words;
  chip.textContent = !words ? '' : out > 0 ? t(shown > 0 ? 'sidebar.hideAiTabs.chipMore' : 'sidebar.hideAiTabs.chip', { count: out }) : t('sidebar.hideAiTabs.chipInView', { count: shown });
  hideAiButton.classList.toggle('has-label', words);
  badge.hidden = count === 0 && !(on && shown > 0); // (the stylesheet hides it while the words show, and brings it back in a narrow window)
  badge.textContent = count > 99 ? '99+' : String(count || shown);
}
hideAiButton?.addEventListener('click', async () => {
  const on = await Promise.resolve(window.browser.hideAiTabs?.(window.lumenHideAiTabs !== true)).catch(() => window.lumenHideAiTabs === true);
  if (typeof on === 'boolean' && window.lumenHideAiTabs !== on) { window.lumenHideAiTabs = on; document.dispatchEvent(new Event('lumen:hide-ai-tabs')); }
});
document.addEventListener('lumen:hide-ai-tabs', () => { if (lastTabState) { syncHideAiToggle(lastTabState); lastLayoutSig = null; renderTabsNow(lastTabState); } });

function renderTabsNow(state) {
  // Updates wait while tabs are being moved here, but not while they are out on the card: the strip then
  // shows the window as it is (the tab beside the dragged one active, say), keeping the dragged tabs folded.
  const out = drag?.handed && !drag.single;
  if (renamingGroup !== null || awaitingMove || (!out && (drag || stripPressed))) {
    pendingState = state;
    return;
  }
  lastTabState = state;
  syncHideAiToggle(state);
  if (!drag?.handed) pruneSelection(state);
  const container = $('tabs');
  const sig = layoutSig(state);
  const patchOnly = tabsRendered && sig === lastLayoutSig && !landingSlot && !dropSlot && !drag && !heldTab && !arriving.size && !widthsHeld && !container.querySelector('.tab-drop-slot');
  lastLayoutSig = sig;
  const before = new Map();
  for (const el of container.querySelectorAll('.tab, .group-label')) before.set(el.dataset.id, { el, rect: patchOnly ? null : el.getBoundingClientRect() });
  // A drop slot left open for a tab that was just released over this strip (onTabDropAt): measured open
  // above, so the tabs close up from there, and the tab that arrives (or, back in its own strip, the one
  // that was held hidden) takes its place.
  // The slot is only used up by the update that fills it: tabs new to this strip, or a block moved along
  // it. Any other update (a title, a stale one held back during the drag) leaves it where it is, and a
  // drop back into this strip fills it when main confirms ('tab:dragdone', releaseHeldTab).
  const landing = landingSlot;
  const fresh = state.tabs.filter((t) => !before.has(String(t.id))).map((t) => String(t.id));
  let landedIds = [];
  let filled = false;
  if (landing && !heldTab && fresh.length) { filled = true; landedIds = fresh; }
  if (filled) { clearTimeout(landing.timer); landing.el.remove(); landingSlot = null; }
  const switched = state.activeId !== lastActiveId;
  const groupsById = new Map((state.groups || []).map((g) => [g.id, g]));
  // Many tabs: a group's label becomes a compact chip, its name kept and clipped with an ellipsis (36px at least, 84px at most; the tabs give way, the
  // strip scrolls). It collapses to a bare dot only when the chips themselves would take most of the strip: so many groups that names cannot all be shown.
  const chipWidth = (g) => Math.min(84, Math.max(36, String(g.name || '').length * 6.6 + 18)) + 6; // (an estimate: the text, the padding and the gap beside it)
  const chips = (state.groups || []).reduce((n, g) => n + chipWidth(g), 0);
  const crowded = state.tabs.length <= 12 ? '' : container.clientWidth > 0 && chips > container.clientWidth * 0.8 ? 'dot' : 'crowded';
  let currentGroup = null;
  // Shown when Organize would do something: 4+ tabs it may regroup (main counts them: not pinned, not in the user's own
  // groups; automatic groups' tabs count). 4 is the bar automatic by-topic grouping uses: fewer is easy to do by hand.
  organizeBtn.hidden = !(state.organizable >= 4) && !organizeBtn.classList.contains('busy');
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
    if (aiHiddenTab(tab, state)) continue; // [ai manners] left out of the strip by the sidebar's toggle (still open)
    const group = tab.groupId ? groupsById.get(tab.groupId) : null;
    if (group && currentGroup !== group.id) {
      wanted.push(groupLabel(group, state.tabs.filter((t) => t.groupId === group.id && !aiHiddenTab(t, state)).length, crowded, before.get(`g${group.id}`)?.el));
    }
    currentGroup = group ? group.id : null;
    if (group?.collapsed && tab.id !== state.activeId && drag?.id !== tab.id && !drag?.group?.includes(tab.id)) continue; // the active tab (and one being dragged) stays
    wanted.push(updateTabEl(before.get(String(tab.id))?.el || createTabEl(tab.id), tab, group, state.activeId));
  }
  const keep = new Set(wanted);
  if (patchOnly && wanted.length === before.size && wanted.every((el) => before.get(el.dataset.id)?.el === el)) {
    finishTabsRender(state, before, container, switched);
    return;
  }
  if (patchOnly) for (const v of before.values()) v.rect = v.el.getBoundingClientRect(); // the strip did differ after all
  for (const { el } of before.values()) if (!keep.has(el)) el.remove();
  // Drop slots aren't tabs: they step out while the tabs are put in order (or they'd end up last), and the
  // open one goes back in front of the same tab. A closing one is simply gone.
  const slots = [dropSlot?.el, landingSlot?.el].filter((el) => el?.isConnected).map((el) => {
    let anchor = el.nextElementSibling;
    while (anchor?.classList.contains('tab-drop-slot')) anchor = anchor.nextElementSibling;
    return { el, anchor };
  });
  container.querySelectorAll('.tab-drop-slot').forEach((el) => el.remove());
  // Only elements out of place move, so the rest aren't detached mid-click.
  let cursor = tabIndicator.nextSibling;
  for (const el of wanted) {
    if (el === cursor) cursor = el.nextSibling;
    else container.insertBefore(el, cursor);
  }
  for (const { el, anchor } of slots) container.insertBefore(el, anchor?.parentNode === container ? anchor : null);

  // A tab arriving while widths are held (see holdTabWidths) would be squeezed in beside them.
  if (widthsHeld && wanted.some((el) => el.classList.contains('tab') && !before.has(el.dataset.id))) releaseTabWidths(false);
  const landed = new Set(landedIds.filter((x) => !arriving.has(Number(x))).map((x) => container.querySelector(`.tab[data-id="${x}"]`)).filter(Boolean));
  animateTabs(before, container, landed);
  if (landed.size) {
    for (const el of landed) {
      el.classList.remove('landed');
      void el.offsetWidth; // restart the ring if it was still showing
      el.classList.add('landed');
      setTimeout(() => el.classList.remove('landed'), 1000);
    }
    const live = $('tab-live');
    const first = state.tabs.find((x) => String(x.id) === landedIds[0]);
    if (live) live.textContent = landedIds.length > 1 ? t('tabs.movedHereMany', { n: landedIds.length }) : t('tabs.movedHere', { title: first?.title || '' });
  }
  finishTabsRender(state, before, container, switched);
}

// Everything after the strip itself: the indicator, the toolbar state of the active tab.
function finishTabsRender(state, before, container, switched) {
  updateHoverCard();
  const activeId = container.querySelector('.tab.active')?.dataset.id;
  placeIndicator(tabsRendered && !motionReduced() && [...before.keys()].includes(activeId));
  tabsRendered = true;
  updateOverflow();
  syncTabStripKeyboard();
  if (selectAfterRender) { const ids = selectAfterRender.filter((x) => state.tabs.some((t) => t.id === x)); selectAfterRender = null; if (ids.length > 1) setSelection(ids); }

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
  setMarkup($('reload-icon'), active?.loading
    ? '<path d="M4 4l8 8M12 4l-8 8"/>'
    : '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5"/>');
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
// A click anywhere in the field (the padding around the text, the security label, the gaps by the buttons) opens the
// address, not only a click on the text itself (the input is only as wide as its text while it isn't focused).
$('omnibox').addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target === address || e.target.closest('button, a, [role="button"]')) return;
  e.preventDefault(); // the click would otherwise land on nothing and leave the page holding focus
  const wasFocused = document.activeElement === address && document.hasFocus();
  address.focus();
  if (!wasFocused) address.select();
  else address.setSelectionRange(address.value.length, address.value.length);
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
    if (text) { showSidebar(true); askInNewChat(text); }
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
// The address bar always navigates or searches; the new-tab page's Search | Ask AI choice is its own
// and never reaches here.
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
$('reader').onclick = () => window.browser.toggleReader?.();
$('new-tab').onclick = () => window.browser.newTab(); // the new tab's search box takes the keyboard
// The lock (or "Not secure") opens the site's page info under it.
function openPageInfo() {
  const r = $('security').getBoundingClientRect();
  window.browser.openPageInfo?.({ x: Math.round(r.left), y: Math.round(r.bottom + 4) });
}
$('security').addEventListener('click', openPageInfo);
$('security').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPageInfo(); } });
$('app-menu').onclick = () => {
  const r = $('app-menu').getBoundingClientRect();
  // `right` lets main.js right-align the menu to the button, inside the window (app-menu-layout.js).
  window.browser.openAppMenu?.({ x: Math.round(r.left), y: Math.round(r.bottom), right: Math.round(r.right) });
};
// Extension icons past the list's width cap are clipped: a "..." button lists them, and a pick triggers the
// extension as its icon does. (The list is a custom element with an open shadow root of one button per action.)
{
  const list = $('extension-actions');
  const more = $('actions-overflow');
  const hiddenActions = () => {
    const lr = list.getBoundingClientRect();
    return [...(list.shadowRoot?.querySelectorAll('.action') || [])].filter((n) => n.getBoundingClientRect().right > lr.right + 1);
  };
  let frame = 0;
  const refresh = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; more.hidden = !hiddenActions().length; });
  };
  new ResizeObserver(refresh).observe(list);
  customElements.whenDefined('browser-action-list').then(() => {
    // subtree + attributes: a button's own size/visibility can change (badge, popup state) without a child being added
    if (list.shadowRoot) new MutationObserver(refresh).observe(list.shadowRoot, { childList: true, subtree: true, attributes: true });
    refresh();
  });
  more.onclick = () => {
    const r = more.getBoundingClientRect();
    window.browser.openActionsOverflow?.({ x: Math.round(r.left), y: Math.round(r.bottom) }, hiddenActions().map((n) => ({ id: n.id, title: n.title || '' })));
  };
  window.browser.onActionsOverflowPick?.((id) => {
    const node = [...(list.shadowRoot?.querySelectorAll('.action') || [])].find((n) => n.id === id);
    const r = more.getBoundingClientRect();
    window.browserAction?.activate(list.partition || '_self', { eventType: 'click', extensionId: id, tabId: node?.tab ?? list.tab ?? -1, alignment: list.alignment, anchorRect: { x: r.left, y: r.top, width: r.width, height: r.height } });
  });
}
$('agent-stop').onclick = () => window.assistant.stop();
// The buttons at the address field's right end (zoom, translate, reader, star, reload) are laid over
// it, so the field's padding has to clear however many are showing: styles.css reads their width
// from --omnibox-end-w. A fixed 62px only cleared two, and the URL ran under the rest.
{
  const omnibox = $('omnibox');
  const end = omnibox.querySelector('.omnibox-end');
  new ResizeObserver(() => omnibox.style.setProperty('--omnibox-end-w', `${Math.ceil(end.offsetWidth)}px`)).observe(end);
}

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

// The sidebar springs open from the window's trailing edge. `reveal` (0–1) drives a transform and an
// opacity on the sidebar element alone (it stays laid out at its final width, floating over the page
// area while body.sidebar-moving), and the native page view keeps its final size (heldRect).
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

// The sidebar's spring state is two inline properties on that one element.
function revealStyles(x) {
  const c = Math.min(1, Math.max(0, x));
  return { transform: c >= 1 ? '' : `translate3d(${((1 - c) * 100).toFixed(3)}%, 0, 0)`, opacity: c >= 1 ? '' : String((0.25 + c * 0.75).toFixed(3)) };
}
function clearReveal() {
  const st = $('sidebar').style;
  st.transform = '';
  st.opacity = '';
}

// While the page is a still image, main's last-resort thaw timer is told every second that motion goes on.
let lastFreezeAlive = -Infinity;
function freezeAlive() {
  const now = performance.now();
  if (now - lastFreezeAlive < 1000) return;
  lastFreezeAlive = now;
  window.browser.freezeAlive?.();
}

function setReveal(x) {
  reveal = x;
  if (snapshot) freezeAlive();
  const st = $('sidebar').style;
  const v = revealStyles(x);
  st.transform = v.transform;
  st.opacity = v.opacity;
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

// fade: the snapshot eases in over --t-press (a shortcut-started spring, where the capture lands mid-animation).
// The last page edge colour seen: a resize drag shows it in the area the page hasn't caught up with yet,
// before its own snapshot (50-200 ms) is ready.
let lastSnapshotEdge = '';
async function freezePage({ fade = false } = {}) {
  const token = ++freezeToken;
  // The area the snapshot fills, in CSS pixels: main captures it at that size, not at device size.
  const r = heldRect || viewport.getBoundingClientRect();
  const bytes = await window.browser.freezeView?.({ width: Math.round(r.width), height: Math.round(r.height) });
  if (!bytes || token !== freezeToken) return;
  // The JPEG arrives as bytes (not a base64 data URI): a blob URL costs no giant string to build or parse.
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  const img = new Image();
  img.className = 'page-snapshot';
  img.alt = '';
  img.src = url;
  img.style.width = `${r.width}px`;
  img.style.height = `${r.height}px`;
  const decoded = await img.decode().then(() => true, () => false);
  const arrival = snapshotArrival({ token, current: freezeToken, decoded });
  if (arrival !== 'show') { // superseded while decoding, or a broken image: never replace the live page with it
    URL.revokeObjectURL(url);
    if (arrival === 'thaw') thawPage();
    return;
  }
  if (snapshot) { snapshot.remove(); URL.revokeObjectURL(snapshot.src); }
  snapshot = img;
  if (fade) img.classList.add('fade-in');
  lastSnapshotEdge = edgeColor(img);
  viewport.style.setProperty('--snapshot-edge', lastSnapshotEdge);
  viewport.append(img);
}

const SNAPSHOT_REMOVE_DELAY_MS = 80; // the live page is back a moment before the still image leaves, so no blank frame shows
function thawPage() {
  freezeToken++;
  const img = snapshot;
  snapshot = null;
  // Swap the live page back a frame after the motion has settled, not on its last frame.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.browser.thawView?.();
    if (img) setTimeout(() => { img.remove(); URL.revokeObjectURL(img.src); viewport.style.removeProperty('--snapshot-edge'); }, SNAPSHOT_REMOVE_DELAY_MS);
  }));
}

const SPRING_OPEN_RESPONSE = 0.34, SPRING_CLOSE_RESPONSE = 0.28; // seconds: closing is a little quicker

// [sidebar per tab] Whether the sidebar is open belongs to the tab (main.js sidebar:set, features/sidebar-tabs.js): a toggle,
// Ctrl+J, or an agent feature opening it asks for the tab in front; a tab switch (or a tabs state naming the sidebar of the tab in
// front) only shows that tab's answer (`fromTab`) and tells main nothing. Its width stays one setting for the window.
let sidebarPending = 0; // answers asked of main and not yet confirmed: a tabs state sent before them must not undo them
function reportTabSidebar(open, tabId = null) { // (no tab named: main's front tab, which is what the user acted on even if this window's strip is a moment behind)
  if (!window.assistant.setSidebarOpen) return;
  sidebarPending++;
  Promise.resolve(window.assistant.setSidebarOpen(tabId, open)).catch(() => {}).finally(() => { sidebarPending--; });
}

// visible: the wish. fromTab: following the tab in front (no report to main, the prompt keeps the focus it has).
// instant: no spring (the first state of a window, a full-page chat docking back to a closed tab).
async function showSidebar(visible, { fromTab = false, instant = false } = {}) {
  const body = document.body;
  const still = instant || motionReduced(); // (no motion: the single reportBounds() in finish() sends the final size)
  $('sidebar').classList.remove('prewarm'); // never animate from the warm-up layout
  $('toggle-sidebar').setAttribute('aria-pressed', String(visible));
  window.assistant.sidebarState?.(visible); // main: when to notify about a reply, and the unread mark
  if (!fromTab) reportTabSidebar(visible);
  const wasEarly = Boolean(earlyFreeze);
  if (earlyFreeze) {
    const pending = earlyFreeze;
    earlyFreeze = null;
    await pending;
  }
  // No head start (a keyboard shortcut): the spring doesn't wait for the capture. The page area stays its
  // background colour or the live page until the snapshot lands, and swaps in then (at the end of this function).
  const lateFreeze = !wasEarly && !revealAnim && !still && !snapshot;
  const velocity = revealAnim?.velocity || 0;
  const interrupted = Boolean(revealAnim);
  revealAnim?.stop();
  revealAnim = null;
  const wasHidden = body.classList.contains('sidebar-hidden');
  if (visible && wasHidden) body.classList.remove('sidebar-hidden');
  const target = visible ? 1 : 0;
  // Opening: the page takes its narrower size now and the sidebar slides over the space.
  // Closing: the page keeps its size until the sidebar has gone, then widens once.
  // (Interrupted mid-spring, the page area is already floating at full size: keep the size held.)
  if (!(interrupted && heldRect)) {
    body.classList.remove('sidebar-moving'); // measure the settled layout
    heldRect = viewport.getBoundingClientRect();
  }
  if (visible && wasHidden) setReveal(0);
  if (!still) body.classList.add('sidebar-moving'); // styles.css: the sidebar floats and slides by transform
  reportBounds();
  const finish = () => {
    revealAnim = null;
    heldRect = null;
    body.classList.remove('sidebar-moving');
    thawPage();
    clearReveal();
    if (!visible) body.classList.add('sidebar-hidden');
    reveal = target;
    reportBounds();
  };
  // Reduced motion: no spring, so heldRect is set above only to be cleared by finish() in the same tick;
  // the single reportBounds() inside finish() then sends the final size and nothing animates.
  if (still) finish();
  else {
    // Starting from rest: let the first layout/paint of the sidebar and snapshot land before
    // motion begins, so any slow frame is a still frame, not a jump.
    revealAnim = springTo(reveal, target, { response: visible ? SPRING_OPEN_RESPONSE : SPRING_CLOSE_RESPONSE, velocity, onUpdate: setReveal, onDone: finish });
  }
  if (lateFreeze && revealAnim) freezePage({ fade: true }); // sized from heldRect, the page's final size, already set above
  if (visible && !fromTab) $('prompt').focus({ preventScroll: true });
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
  // Until the snapshot is up (a full-page capture takes 50-200 ms) the page is still live, and resizing it
  // every frame made the site reflow on each one: the first moments of a drag stuttered. Its size is held for
  // the whole drag and sent once at the end, as the sidebar's spring does (heldRect).
  let ended = false;
  const held = frozen && !heldRect;
  if (held) {
    heldRect = viewport.getBoundingClientRect();
    if (lastSnapshotEdge) viewport.style.setProperty('--snapshot-edge', lastSnapshotEdge); // body.resizing paints it behind the held page
    frozen.then(() => { if (!ended && !snapshot && heldRect) { heldRect = null; reportBounds(); } }); // no snapshot came: don't leave the page at a stale size
  }
  let frame = 0;
  // A still pointer sends no moves, and main thaws a freeze that has been quiet for 6 s: keep it alive until the drag ends.
  // Capped (freeze-keepalive.js): a pointer held for over a minute stops pinging and main thaws the page.
  const alive = freezeKeepAlive(freezeAlive);
  const move = (ev) => {
    cancelAnimationFrame(frame);
    freezeAlive();
    frame = requestAnimationFrame(() => setSidebarWidth(startWidth + (startX - ev.clientX)));
  };
  const up = async () => {
    ended = true;
    alive.stop();
    resizer.removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    localStorage.setItem('sidebarWidth', String(Math.round($('sidebar').getBoundingClientRect().width)));
    if (frozen) {
      await frozen;
      if (held) { heldRect = null; reportBounds(); } // the page's final size, once, while it is still hidden
      thawPage();
    }
    if (!snapshot) viewport.style.removeProperty('--snapshot-edge');
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
// Ctrl+Shift+K: the New chat button, opening the sidebar first (a run in progress keeps going in its own chat).
window.browser.onNewSidebarChat(async () => {
  if ($('toggle-sidebar').getAttribute('aria-pressed') !== 'true') await showSidebar(true);
  // A hidden sidebar can't take focus: wait (briefly) until it is really shown.
  for (let i = 0; i < 40 && document.body.classList.contains('sidebar-hidden'); i++) await new Promise((r) => setTimeout(r, 25));
  $('new-chat').click();
  const focusPrompt = () => $('prompt').focus({ preventScroll: true });
  focusPrompt();
  requestAnimationFrame(focusPrompt); // the new chat's reset can re-render the prompt area
});

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
  document.body.classList.remove('sidebar-moving');
  if (snapshot) thawPage();
  // Full mode ignores the spring (CSS forces width: 100%), but reset it so docking back later — which
  // does nothing but remove the chat-full class — lands on a fully open sidebar, not a stale partial one.
  document.body.classList.remove('sidebar-hidden');
  clearReveal();
  reveal = 1;
  $('toggle-sidebar').setAttribute('aria-pressed', 'true');
  window.assistant.sidebarState?.(true);
  reportTabSidebar(true, fullChatTabId); // [sidebar per tab] a full-page chat is the sidebar open, for its tab
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
  else { // a different tab is active: dock back, but keep remembering this one
    if (!state.sidebar) showSidebar(false, { fromTab: true, instant: true }); // [sidebar per tab] that tab's sidebar is closed: no docked flash
    exitFull(false);
  }
}
window.browser.onTabs(watchFullChatTab);

// [sidebar per tab] Every tabs state names whether the sidebar is open on the tab in front. A tab switch (or the first state of a window,
// a tab moved here) shows that tab's answer; a state for the same tab only follows a change made elsewhere (a window showing a tab that
// shares its chat), and not while this window's own answer is on its way to main.
let sidebarTabShown = null;
function followTabSidebar(state) {
  const switched = state.activeId !== sidebarTabShown;
  const first = sidebarTabShown === null;
  sidebarTabShown = state.activeId;
  if (chatFull) return; // a full-page chat is the sidebar open (watchFullChatTab docks it back when its tab is left)
  if (sidebarPending > 0 && (!switched || first)) return; // (a state sent before this window's own answer, which it already carries: the welcome, a click before the first state)
  const want = Boolean(state.sidebar);
  if (want !== ($('toggle-sidebar').getAttribute('aria-pressed') === 'true')) showSidebar(want, { fromTab: true, instant: first });
}
window.browser.onTabs(followTabSidebar);

$('dock-to-side').onclick = () => exitFull();
// Escape anywhere in the chat docks a full-page chat back, except inside the model picker's own
// search popup, which handles Escape itself (closing the popup, not the chat), and any menu, list or card
// that already used this Escape (closing itself: it prevented the default).
$('sidebar').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !chatFull || e.defaultPrevented) return;
  if (e.target.closest('.model-picker, .more-menu, .chats-panel, .approval, [role="menu"], [role="dialog"]')) return;
  e.preventDefault();
  exitFull();
});

// "Ask AI" on the new-tab page: that tab's chat opens full-page instead of docking to the side.
window.browser.onAskFromHome?.(({ text, tabId }) => {
  fullChatTabId = tabId ?? lastTabState?.activeId ?? null;
  enterFull();
  askInNewChat(text); // a fresh chat each time; the previous one stays in the chat list
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
// [agent window] This window is an outside agent's own (Claude Code, Codex…): a badge in the toolbar says whose it is.
window.browser.onAgentWindow?.((info) => {
  const chip = $('agent-window-chip');
  document.body.classList.toggle('agent-window', Boolean(info));
  if (!chip) return;
  chip.hidden = !info;
  chip.textContent = info ? t('agentWindow.badge', { client: info.label }) : '';
  chip.title = info ? t('agentWindow.title', { client: info.label }) : '';
});

// ---------- the chat's hooks into the sidebar (chat-core.js) ----------

chatHost.running = () => reportBounds(); // the AI frame around the page appears and goes with a reply

// The AI working on its own (features/chat-runs.js): a dot on the toolbar button when a reply finished
// while the sidebar was closed, or a run (in any chat) waits for an OK; the Chats button shows the same
// for chats other than the open one. A notification clicked opens the sidebar on its chat.
window.assistant.sidebarState?.(!document.body.classList.contains('sidebar-hidden'));
window.assistant.onAttention?.(({ state } = {}) => {
  for (const id of ['toggle-sidebar', 'chat-history']) {
    const el = $(id);
    if (!el) continue;
    if (state) el.dataset.attention = state;
    else delete el.dataset.attention;
  }
});
window.assistant.onOpenChat?.(async ({ id } = {}) => {
  if (chatFull) exitFull();
  if ($('toggle-sidebar').getAttribute('aria-pressed') !== 'true') await showSidebar(true);
  await window.chatList?.openChat?.(id);
});
window.assistant.setup?.onWelcome?.(() => showSidebar(true)); // a fresh install: the sidebar opens on its welcome (chat-core.js)
chatHost.needSidebar = () => { if (document.body.classList.contains('sidebar-hidden')) showSidebar(true); };
chatHost.identity = (who, first) => {
  const button = $('toggle-sidebar');
  button.title = `${who.name} (${navigator.platform.startsWith('Mac') ? '⌘J' : 'Ctrl+J'})`;
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
// External agents (Claude Code, Codex, Antigravity…) drive the browser; their calls show here.

const mcpSteps = new Map(); // step id -> row
let mcpPillText = null;
// The pill says an outside agent is acting: a tool call of an MCP agent is running, or a CDP client (Playwright)
// is attached. A connected-but-idle MCP agent (Claude Code keeps its session open all day) and Lumen's own
// engine sessions don't count. It holds for a moment after the last call so a run of calls doesn't flicker,
// and the chat gets one line the first time each agent connects in this window, never one per session.
const MCP_PILL_HOLD_MS = 1500;
const mcpAnnounced = new Set();
const mcpRunning = new Set(); // ids of the MCP tool calls in flight
let mcpCdpActive = false;
let mcpWho = '';
let mcpPillTimer = null;

function mcpPillRefresh() {
  const driving = mcpCdpActive || mcpRunning.size > 0;
  const showPill = () => {
    document.body.classList.toggle('mcp-active', driving);
    const text = document.querySelector('#agent-pill span:not(.agent-dot)');
    if (!text) return;
    if (mcpPillText === null) mcpPillText = text.textContent;
    text.textContent = driving ? t('mcp.driving', { client: mcpWho }) : mcpPillText;
  };
  clearTimeout(mcpPillTimer);
  if (driving) showPill();
  else mcpPillTimer = setTimeout(showPill, MCP_PILL_HOLD_MS);
}

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
      // MCP sessions carry `engine` (null for an outside agent) and only announce; the CDP proxy's don't and drive the pill.
      if (!('engine' in event)) { mcpCdpActive = Boolean(event.active || event.remaining > 0); if (mcpCdpActive) mcpWho = event.clientName; mcpPillRefresh(); }
      if (event.engine) break; // Lumen's own engine, not an outside agent
      if (event.active && !mcpAnnounced.has(event.clientName)) {
        mcpAnnounced.add(event.clientName);
        append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('mcp.connected', { client: event.clientName }) }));
      }
      break;
    }
    case 'tool':
      mcpStepRow(event);
      mcpRunning.add(event.id);
      mcpWho = event.clientName;
      mcpPillRefresh();
      break;
    case 'tool_update': { // the specific label of a step already shown (an outside agent's usually came in its 'tool' event)
      const step = mcpSteps.get(event.id);
      if (!step || !event.label || !step.firstChild) break;
      step.firstChild.textContent = `${event.clientName}: ${event.label}`;
      step.title = step.firstChild.textContent;
      break;
    }
    case 'tool_done': {
      mcpRunning.delete(event.id);
      mcpPillRefresh();
      const step = mcpSteps.get(event.id);
      if (!step) break;
      step.className = `step mcp-step ${event.ok ? 'done' : 'failed'}`;
      if (!event.ok && event.error) step.append(Object.assign(document.createElement('span'), { className: 'step-error', textContent: event.error }));
      mcpSteps.delete(event.id);
      break;
    }
    case 'approval': {
      // (An outside agent's card is quiet: with the sidebar closed the AI button carries a badge instead, and the card waits for the user.)
      if (document.body.classList.contains('sidebar-hidden') && !event.quiet) showSidebar(true);
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
