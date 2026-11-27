// The bookmarks bar under the toolbar, as in Chrome: a site's icon and title per bookmark, folders that open as menus (nested
// folders are submenus), » for the chips that don't fit, drag to reorder or into a folder, a link or a tab dropped on it, and a
// right-click menu (Open in new tab, Edit, Delete, New folder). The menus are native ones from main (features/bookmark-bar-main.js);
// the model is features/bookmark-bar.js. Edit and New folder open a small form in the bar itself.
//
// Where it sits: Settings → Appearance → Show bookmarks bar (Ctrl+Shift+B). 'always': in the header under the toolbar, so the page
// area starts below it. 'newtab' (the default): over the top of the page area, shown only while a new-tab page is in front, and only
// that page's view leaves room for it (main.js newTabArea): no other page is resized when it comes and goes. The mode at start comes
// with the window (preload.js bookmarksBarStart), so the bar has its place before the first size is reported: no jump.
{
  const api = window.browser.bookmarksBar;
  const t = window.t || ((k) => k);
  const bar = document.getElementById('bookmarks-bar');
  const itemsEl = document.getElementById('bm-items');
  const more = document.getElementById('bm-overflow');
  const form = document.getElementById('bm-edit');
  const caret = document.getElementById('bm-caret');
  const header = document.querySelector('header.chrome');
  const viewport = document.getElementById('viewport');
  const toolbar = document.querySelector('nav.toolbar');
  const KEY_TYPE = 'application/x-lumen-bookmark';

  let mode = ['always', 'newtab', 'never'].includes(window.browser.bookmarksBarStart) ? window.browser.bookmarksBarStart : 'newtab';
  let shown = mode === 'always';
  let items = [];
  let editing = null; // the payload being edited (main's 'bookmarks-bar:edit'), or null
  let focusKey = null; // the chip that has the bar's one tab stop (roving tabindex)
  let firstHidden = -1; // the first chip moved into »

  const keyOf = (c) => (c.type === 'link' ? `u:${c.url}` : `f:${c.path}`);
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const svg = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = d; return s; };
  const FOLDER = '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z"/>';
  const GLOBE = '<circle cx="8" cy="8" r="5.75"/><path d="M2.5 8h11M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75C6.4 12.15 5.6 10.25 5.6 8S6.4 3.85 8 2.25z"/>';

  // ---- where the bar sits ----
  function place() {
    const always = mode === 'always';
    const parent = always ? header : viewport;
    if (bar.parentElement !== parent) {
      if (always) toolbar.after(bar); else viewport.prepend(bar);
    }
    bar.classList.toggle('bm-overlay', !always);
    bar.hidden = mode === 'never' || !shown;
    if (bar.hidden && bar.contains(document.activeElement)) document.getElementById('address')?.focus();
    if (!bar.hidden) requestAnimationFrame(fit);
    reportRect();
  }
  // Main needs where the bar is on screen: a tab dragged out of the strip and let go over it is bookmarked, not torn off.
  let lastRect = '';
  function reportRect() {
    const r = bar.hidden ? null : bar.getBoundingClientRect();
    const key = r ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}` : '';
    if (key === lastRect) return;
    lastRect = key;
    api.setRect?.(r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null);
  }

  // ---- the chips ----
  function chip(c, index) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `bm-chip ${c.type === 'folder' ? 'bm-folder' : 'bm-link'}`;
    b.dataset.key = keyOf(c);
    b.dataset.index = String(index);
    b.draggable = true;
    b.tabIndex = -1;
    if (c.type === 'link') {
      const name = c.title || host(c.url);
      if (c.icon) {
        const img = document.createElement('img');
        img.className = 'bm-icon';
        img.alt = '';
        img.src = c.icon;
        img.draggable = false;
        b.append(img);
      } else {
        b.append(Object.assign(svg(GLOBE), { classList: 'bm-icon bm-glyph' }));
      }
      b.append(Object.assign(document.createElement('span'), { className: 'bm-label', textContent: name }));
      b.title = c.title && c.title !== c.url ? `${c.title}\n${c.url}` : c.url;
      b.setAttribute('aria-label', name);
      b.setAttribute('aria-description', host(c.url));
    } else {
      b.append(Object.assign(svg(FOLDER), { classList: 'bm-icon bm-glyph' }));
      b.append(Object.assign(document.createElement('span'), { className: 'bm-label', textContent: c.name }));
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      b.setAttribute('aria-label', t('bookmarksBar.folderNamed', { name: c.name }));
    }
    return b;
  }
  function render() {
    if (editing) return; // (the form keeps the bar until it closes; render() runs again then)
    const hadFocus = bar.contains(document.activeElement);
    const nodes = items.map(chip);
    if (!nodes.length) {
      const empty = document.createElement('span');
      empty.className = 'bm-empty';
      empty.textContent = t('bookmarksBar.emptyHint');
      itemsEl.replaceChildren(empty);
    } else itemsEl.replaceChildren(...nodes);
    fit();
    if (hadFocus) focusChip(focusKey);
  }
  // The chips that don't fit go into » (from the first one that would cross the edge).
  function fit() {
    if (bar.hidden || editing) return;
    const chips = [...itemsEl.querySelectorAll('.bm-chip')];
    for (const c of chips) c.hidden = false;
    more.hidden = true;
    firstHidden = -1;
    if (!chips.length) { rove(); return; }
    const room = itemsEl.getBoundingClientRect();
    if (chips[chips.length - 1].getBoundingClientRect().right <= room.right + 0.5) { rove(); return; }
    more.hidden = false;
    const limit = itemsEl.getBoundingClientRect().right; // (narrower now: » takes its room)
    const i = chips.findIndex((c) => c.getBoundingClientRect().right > limit + 0.5);
    firstHidden = i < 0 ? chips.length : i;
    for (const c of chips.slice(firstHidden)) c.hidden = true;
    more.setAttribute('aria-label', t('bookmarksBar.moreCount', { count: chips.length - firstHidden }));
    rove();
  }
  new ResizeObserver(() => { fit(); reportRect(); }).observe(bar);
  window.addEventListener('resize', reportRect);

  // ---- keyboard: one tab stop, arrows between chips (a toolbar's roving tabindex) ----
  const stops = () => [...bar.querySelectorAll('.bm-chip:not([hidden]), #bm-overflow:not([hidden])')];
  function rove() {
    const all = stops();
    const keep = all.find((b) => b.dataset.key === focusKey) || all[0];
    for (const b of all) b.tabIndex = b === keep ? 0 : -1;
  }
  function focusChip(key) {
    const all = stops();
    const b = all.find((x) => x.dataset.key === key) || all[0];
    if (!b) return;
    focusKey = b.dataset.key || null;
    rove();
    b.focus();
  }
  bar.addEventListener('focusin', (e) => { const b = e.target.closest?.('.bm-chip, #bm-overflow'); if (b) { focusKey = b.dataset.key || null; rove(); } });
  bar.addEventListener('keydown', (e) => {
    if (editing || !e.target.closest?.('.bm-chip, #bm-overflow')) return;
    const all = stops();
    const i = all.indexOf(e.target);
    const go = (j) => { e.preventDefault(); const b = all[(j + all.length) % all.length]; focusKey = b.dataset.key || null; rove(); b.focus(); };
    if (e.key === 'ArrowRight') go(i + 1);
    else if (e.key === 'ArrowLeft') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(all.length - 1);
    else if (e.key === 'ArrowDown' && e.target.classList.contains('bm-folder')) { e.preventDefault(); openFolder(e.target); }
    else if (e.key === 'ArrowDown' && e.target === more) { e.preventDefault(); openOverflow(); }
    else if (e.key === 'Escape') { e.preventDefault(); document.getElementById('address')?.focus(); }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); contextFor(e.target, null); }
  });

  // ---- open ----
  const below = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom + 2 }; };
  async function openFolder(b) {
    b.setAttribute('aria-expanded', 'true');
    b.classList.add('open');
    try { await api.folderMenu({ path: b.dataset.key.slice(2), at: below(b) }); } finally { b.setAttribute('aria-expanded', 'false'); b.classList.remove('open'); }
  }
  async function openOverflow() {
    more.setAttribute('aria-expanded', 'true');
    try { await api.overflowMenu({ from: firstHidden, at: below(more) }); } finally { more.setAttribute('aria-expanded', 'false'); }
  }
  itemsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.bm-chip');
    if (!b) return;
    if (b.classList.contains('bm-folder')) { openFolder(b); return; }
    const url = b.dataset.key.slice(2);
    const how = e.shiftKey ? 'window' : e.ctrlKey || e.metaKey ? 'background' : 'here'; // as in Chrome: Ctrl+click opens behind, Shift+click in a new window
    api.open(url, how);
  });
  // A middle press would start Chromium's autoscroll; the click comes as auxclick.
  itemsEl.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  itemsEl.addEventListener('auxclick', (e) => {
    const b = e.target.closest('.bm-link');
    if (b && e.button === 1) { e.preventDefault(); api.open(b.dataset.key.slice(2), 'background'); }
  });
  more.addEventListener('click', openOverflow);

  // ---- right-click ----
  // `b`: the chip (or null for the bar itself). New folder goes after the chip, or at the end.
  function contextFor(b, e) {
    const at = e ? { x: e.clientX, y: e.clientY } : b ? below(b) : null;
    const chipItem = b?.classList?.contains('bm-chip') ? items[Number(b.dataset.index)] : null;
    const target = chipItem ? (chipItem.type === 'link' ? { type: 'link', url: chipItem.url } : { type: 'folder', path: chipItem.path }) : null;
    api.contextMenu({ target, parent: '', index: chipItem ? Number(b.dataset.index) + 1 : items.length, at });
  }
  bar.addEventListener('contextmenu', (e) => {
    if (editing && form.contains(e.target)) return; // (the form's fields keep their own menu)
    e.preventDefault();
    contextFor(e.target.closest('.bm-chip'), e);
  });

  // ---- Edit, Rename, New folder: a form in the bar ----
  const field = (name, value, labelKey, extra = {}) => {
    const label = document.createElement('label');
    label.className = `bm-field bm-field-${name}`;
    const span = Object.assign(document.createElement('span'), { className: 'bm-field-name', textContent: t(labelKey) });
    const input = Object.assign(document.createElement('input'), { name, value: value || '', spellcheck: false, autocomplete: 'off', ...extra });
    label.append(span, input);
    return { label, input };
  };
  function openEditor(p) {
    editing = p;
    const parts = [];
    let first;
    if (p.type === 'link') {
      const name = field('title', p.title, 'bookmarksBar.edit.name');
      const url = field('url', p.url, 'bookmarksBar.edit.url', { type: 'text' });
      const folder = field('folder', p.folder, 'bookmarksBar.edit.folder', { placeholder: t('bookmarksBar.edit.folderNone') });
      folder.input.setAttribute('list', 'bm-folders');
      const dl = document.createElement('datalist');
      dl.id = 'bm-folders';
      const paths = [];
      const walk = (list) => { for (const c of list) if (c.type === 'folder') { paths.push(c.path); walk(c.children); } };
      walk(items);
      dl.append(...paths.map((v) => Object.assign(document.createElement('option'), { value: v })));
      parts.push(name.label, url.label, folder.label, dl);
      first = name.input;
    } else {
      const name = field('name', p.type === 'new-folder' ? t('bookmarksBar.newFolderName') : p.name, p.type === 'new-folder' ? 'bookmarksBar.edit.newFolder' : 'bookmarksBar.edit.folderName');
      parts.push(name.label);
      first = name.input;
    }
    const error = Object.assign(document.createElement('span'), { className: 'bm-error', role: 'alert' });
    const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'bm-btn', textContent: t('bookmarksBar.edit.cancel') });
    const save = Object.assign(document.createElement('button'), { type: 'submit', className: 'bm-btn bm-primary', textContent: t('bookmarksBar.edit.save') });
    cancel.addEventListener('click', () => closeEditor(true));
    form.replaceChildren(...parts, error, cancel, save);
    form.setAttribute('aria-label', t(p.type === 'link' ? 'bookmarksBar.edit.title' : p.type === 'folder' ? 'bookmarksBar.edit.renameTitle' : 'bookmarksBar.edit.newFolder'));
    form.hidden = false;
    itemsEl.hidden = true;
    more.hidden = true;
    bar.classList.add('editing');
    if (bar.hidden) { bar.hidden = false; }
    first.focus();
    first.select();
  }
  function closeEditor(refocus) {
    const was = editing;
    editing = null;
    form.hidden = true;
    form.replaceChildren();
    itemsEl.hidden = false;
    bar.classList.remove('editing');
    place();
    render();
    if (refocus && was) focusChip(was.type === 'link' ? `u:${was.url}` : was.path ? `f:${was.path}` : focusKey);
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editing) return;
    const p = editing;
    const v = (n) => form.elements[n]?.value ?? '';
    const payload = p.type === 'link'
      ? { type: 'link', url: p.url, newUrl: v('url'), title: v('title'), folder: v('folder') }
      : p.type === 'folder' ? { type: 'folder', path: p.path, name: v('name') } : { type: 'new-folder', parent: p.parent || '', index: p.index, name: v('name') };
    const r = await api.save(payload);
    if (!r?.ok) { form.querySelector('.bm-error').textContent = r?.error || t('bookmarksBar.edit.failed'); return; }
    if (p.type === 'link') editing = { ...p, url: payload.newUrl };
    else if (r.path) editing = { ...p, path: r.path };
    closeEditor(true);
  });
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEditor(true); } });
  api.onEdit((p) => { if (p && typeof p === 'object') openEditor(p); });

  // ---- drag and drop ----
  // Where a drop at x lands: into a folder chip (its middle half), or between chips (index among the bar's chips).
  function dropTarget(x, draggedKey) {
    const chips = [...itemsEl.querySelectorAll('.bm-chip:not([hidden])')];
    for (const c of chips) {
      const r = c.getBoundingClientRect();
      if (x < r.left || x > r.right) continue;
      if (c.classList.contains('bm-folder') && c.dataset.key !== draggedKey && x > r.left + r.width * 0.25 && x < r.right - r.width * 0.25) return { into: c };
    }
    const others = chips.filter((c) => c.dataset.key !== draggedKey);
    let index = others.length;
    for (let i = 0; i < others.length; i++) { const r = others[i].getBoundingClientRect(); if (x < r.left + r.width / 2) { index = i; break; } }
    // (counted among the chips shown; one past them goes after any that are in »)
    const total = items.filter((c) => keyOf(c) !== draggedKey).length;
    const at = index >= others.length ? total : index;
    const ref = others[index] || null;
    return { index: at, ref, before: Boolean(ref) };
  }
  function showCaret(target) {
    for (const c of itemsEl.querySelectorAll('.bm-chip.drop-into')) c.classList.remove('drop-into');
    if (!target) { caret.hidden = true; return; }
    if (target.into) { target.into.classList.add('drop-into'); caret.hidden = true; return; }
    const br = bar.getBoundingClientRect();
    const chips = [...itemsEl.querySelectorAll('.bm-chip:not([hidden])')];
    const last = chips[chips.length - 1];
    const x = target.ref ? target.ref.getBoundingClientRect().left - 3 : last ? last.getBoundingClientRect().right + 2 : itemsEl.getBoundingClientRect().left;
    caret.style.transform = `translateX(${Math.round(x - br.left)}px)`;
    caret.hidden = false;
  }
  let dragKey = null;
  itemsEl.addEventListener('dragstart', (e) => {
    const b = e.target.closest?.('.bm-chip');
    if (!b) return;
    dragKey = b.dataset.key;
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(KEY_TYPE, dragKey);
    if (dragKey.startsWith('u:')) { // (a bookmark dragged into a page or the address bar is its address)
      const url = dragKey.slice(2);
      e.dataTransfer.setData('text/uri-list', url);
      e.dataTransfer.setData('text/plain', url);
    }
    b.classList.add('dragging');
  });
  itemsEl.addEventListener('dragend', (e) => { e.target.closest?.('.bm-chip')?.classList.remove('dragging'); dragKey = null; showCaret(null); });
  const linkOf = (dt) => {
    const uri = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#')) || '';
    const plain = (dt.getData('text/plain') || '').trim();
    const url = /^https?:\/\/\S+$/i.test(uri) ? uri : /^https?:\/\/\S+$/i.test(plain) ? plain : '';
    let title = '';
    const html = dt.getData('text/html');
    if (html) { try { title = new DOMParser().parseFromString(html, 'text/html').body.textContent.replace(/\s+/g, ' ').trim(); } catch { /* no title */ } }
    return { url, title: title && title !== url ? title.slice(0, 300) : '' };
  };
  const accepts = (dt) => { const types = [...(dt?.types || [])]; return types.includes(KEY_TYPE) || types.includes('text/uri-list') || types.includes('text/plain'); };
  bar.addEventListener('dragover', (e) => {
    if (editing || !accepts(e.dataTransfer) || [...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragKey ? 'move' : 'copy';
    showCaret(dropTarget(e.clientX, dragKey));
  });
  bar.addEventListener('dragleave', (e) => { if (!bar.contains(e.relatedTarget)) showCaret(null); });
  bar.addEventListener('drop', async (e) => {
    if (editing || !accepts(e.dataTransfer)) return;
    e.preventDefault(); // (app.js's document handler would open the link in a new tab)
    const key = e.dataTransfer.getData(KEY_TYPE) || dragKey;
    const target = dropTarget(e.clientX, key);
    showCaret(null);
    const to = target.into ? target.into.dataset.key.slice(2) : '';
    const index = target.into ? undefined : target.index;
    if (key) { await api.move({ key, to, index }); return; }
    const link = linkOf(e.dataTransfer);
    if (link.url) await api.drop({ url: link.url, title: link.title, to, index });
  });
  // A tab let go over the bar (main.js: the tab-strip drag ends here instead of tearing the tab off).
  api.onTabOver?.((p) => { if (!p) { showCaret(null); return; } showCaret(dropTarget(p.x, null)); });
  api.onTabDrop?.((p) => {
    showCaret(null);
    if (!p?.url) return;
    const target = dropTarget(p.x, null);
    api.drop({ url: p.url, title: p.title || '', to: target.into ? target.into.dataset.key.slice(2) : '', index: target.into ? undefined : target.index });
  });

  // ---- state from main ----
  function setState(s) {
    if (!s || !Array.isArray(s.items)) return;
    items = s.items;
    if (s.mode && s.mode !== mode) { mode = s.mode; shown = mode === 'always' || (mode === 'newtab' && shown); place(); }
    render();
  }
  api.onState(setState);
  api.get().then(setState).catch(() => {});
  // The tab in front decides it in 'newtab' mode (main.js bookmarkBarShown).
  window.browser.onTabs((state) => {
    const b = state?.bookmarksBar;
    if (!b) return;
    const nextMode = ['always', 'newtab', 'never'].includes(b.mode) ? b.mode : mode;
    if (nextMode === mode && Boolean(b.shown) === shown) return;
    mode = nextMode;
    shown = Boolean(b.shown);
    if (editing && !shown) closeEditor(false);
    place();
  });
  place();
}
