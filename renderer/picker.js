// A themed menu for a <select> (the model pickers). Native select popups are drawn by the OS and don't
// always follow Lumen's theme, so the list is drawn in the page instead. The <select> stays in the DOM
// (visually hidden) as the source of truth: set .value or dispatch 'change' as before, and call
// select.pickerSync() after changing .value from script.
//
// Built for long lists (a few providers can bring 50+ models): a search field once there are more than a
// handful, provider headings that stay in view while their models scroll, the last few picks at the top,
// long groups folded to their first five ("Show all 14"), and one compact row per model: its readable name,
// the id or a note under it, and badges ("chat only", "preview", "sign in"). An <option> may carry
// data-name, data-detail and data-badges (comma separated); otherwise its text is the name.
// Keyboard: the search field is a combobox over the listbox (aria-activedescendant): Up/Down, PageUp/PageDown,
// Home/End move, Enter picks, Esc clears the search, then closes. Typing while the list is open searches.
window.lumenPicker = (select, { label = null, recentKey = null } = {}) => {
  const uid = `pk${Math.random().toString(36).slice(2, 8)}`;
  const nameOf = (o) => o.dataset.name || o.textContent;
  const groupOf = (o) => (o.parentElement?.tagName === 'OPTGROUP' ? o.parentElement.label : '');
  const tr = (key, fallback, vars) => {
    let s = window.t ? window.t(key, vars) : key;
    if (!s || s === key) s = fallback;
    return vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') : s;
  };

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'picker-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', `${uid}-list`);
  if (select.getAttribute('aria-label')) button.setAttribute('aria-label', select.getAttribute('aria-label'));
  const where = Object.assign(document.createElement('span'), { className: 'picker-provider' });
  const text = Object.assign(document.createElement('span'), { className: 'picker-text' });
  button.append(where, text);
  const menu = Object.assign(document.createElement('div'), { className: 'picker-menu', hidden: true });
  const search = Object.assign(document.createElement('input'), { type: 'search', className: 'picker-search', autocomplete: 'off', spellcheck: false });
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-controls', `${uid}-list`);
  search.setAttribute('aria-expanded', 'true');
  search.setAttribute('aria-autocomplete', 'list');
  const list = Object.assign(document.createElement('div'), { className: 'picker-list', id: `${uid}-list` });
  list.setAttribute('role', 'listbox');
  if (select.getAttribute('aria-label')) list.setAttribute('aria-label', select.getAttribute('aria-label'));
  const empty = Object.assign(document.createElement('div'), { className: 'picker-empty', hidden: true });
  menu.append(search, list, empty);
  select.classList.add('picker-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.after(button, menu);

  const sync = () => {
    const option = select.selectedOptions[0];
    if (label) { where.textContent = ''; text.textContent = option ? label(option) : ''; }
    else { where.textContent = option ? groupOf(option) : ''; text.textContent = option ? nameOf(option) : ''; }
    where.hidden = !where.textContent || select.querySelectorAll('optgroup').length < 2;
    button.title = option ? [groupOf(option), nameOf(option), option.dataset.detail || option.title].filter(Boolean).join(' · ') : '';
  };
  select.pickerSync = sync;
  select.addEventListener('change', sync);
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true });

  // The last few picks, per picker (localStorage: a convenience only, so every access is guarded).
  const storeKey = recentKey ? `lumen.picker.recent.${recentKey}` : null;
  const recent = () => { try { return storeKey ? JSON.parse(localStorage.getItem(storeKey) || '[]').filter((v) => typeof v === 'string') : []; } catch { return []; } };
  const remember = (value) => { try { if (storeKey) localStorage.setItem(storeKey, JSON.stringify([value, ...recent().filter((v) => v !== value)].slice(0, 5))); } catch { /* not kept */ } };

  let rows = []; // the option rows on show, in order: { el, value }
  let active = -1;
  let expanded = new Set(); // groups opened past their first five
  const options = () => [...select.querySelectorAll('option')];
  const LONG = 6;
  const SHOWN = 5;

  function setActive(i, scroll = true) {
    if (!rows.length) { active = -1; search.removeAttribute('aria-activedescendant'); return; }
    active = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((r, k) => r.el.classList.toggle('active', k === active));
    search.setAttribute('aria-activedescendant', rows[active].el.id);
    if (scroll) rows[active].el.scrollIntoView({ block: 'nearest' });
  }
  function row(o, key) {
    const el = Object.assign(document.createElement('div'), { className: 'picker-item', id: `${uid}-${key}` });
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', String(o.selected));
    const top = Object.assign(document.createElement('span'), { className: 'picker-line' });
    top.append(Object.assign(document.createElement('span'), { className: 'picker-name', textContent: nameOf(o) }));
    for (const b of (o.dataset.badges || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      top.append(Object.assign(document.createElement('span'), { className: `picker-badge${b === 'sign in' ? ' warn' : ''}`, textContent: b }));
    }
    el.append(top);
    const detail = o.dataset.detail || o.title;
    if (detail) el.append(Object.assign(document.createElement('span'), { className: 'picker-detail', textContent: detail }));
    el.title = [nameOf(o), detail].filter(Boolean).join('\n');
    el.addEventListener('pointerdown', (e) => e.preventDefault()); // keeps the focus in the search field
    el.addEventListener('click', () => choose(o.value));
    el.addEventListener('pointermove', () => { const k = rows.findIndex((r) => r.el === el); if (k !== active) setActive(k, false); });
    rows.push({ el, value: o.value });
    return el;
  }
  function heading(textContent, count) {
    const h = Object.assign(document.createElement('div'), { className: 'picker-group' });
    h.setAttribute('role', 'presentation');
    h.append(Object.assign(document.createElement('span'), { textContent }));
    if (count) h.append(Object.assign(document.createElement('span'), { className: 'picker-count', textContent: String(count) }));
    return h;
  }
  function render() {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const all = options();
    const match = (o) => !words.length || words.every((w) => `${nameOf(o)} ${o.value} ${groupOf(o)} ${o.dataset.detail || ''} ${o.dataset.badges || ''}`.toLowerCase().includes(w));
    const keepActive = rows[active]?.value;
    rows = [];
    const out = [];
    // The last picks first (not while searching, and only when the list is long enough to need them).
    if (!words.length && all.length > 7) {
      const recents = recent().map((v) => all.find((o) => o.value === v)).filter((o) => o && !o.dataset.more).slice(0, 3);
      if (recents.length) {
        out.push(heading(tr('picker.recent', 'Recent')));
        recents.forEach((o, i) => out.push(row(o, `r${i}`)));
      }
    }
    const groups = new Map();
    for (const o of all) { if (!match(o)) continue; const g = groupOf(o); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(o); }
    let n = 0;
    for (const [g, members] of groups) {
      const section = Object.assign(document.createElement('div'), { className: 'picker-section' });
      section.setAttribute('role', 'group');
      if (g && (groups.size > 1 || out.length)) { const h = heading(g, members.length > SHOWN ? members.length : 0); h.id = `${uid}-g${n}`; section.setAttribute('aria-labelledby', h.id); section.append(h); }
      const folded = !words.length && members.length > LONG && !expanded.has(g) && !members.slice(SHOWN).some((o) => o.selected);
      (folded ? members.slice(0, SHOWN) : members).forEach((o, i) => section.append(row(o, `${n}-${i}`)));
      if (folded) {
        const more = Object.assign(document.createElement('div'), { className: 'picker-item picker-more', id: `${uid}-m${n}`, textContent: tr('picker.showAll', 'Show all {n}', { n: members.length }) });
        more.setAttribute('role', 'option');
        more.setAttribute('aria-selected', 'false');
        more.addEventListener('pointerdown', (e) => e.preventDefault());
        more.addEventListener('click', () => { expanded.add(g); render(); });
        rows.push({ el: more, value: null, expand: g });
        section.append(more);
      }
      out.push(section);
      n++;
    }
    list.replaceChildren(...out);
    empty.hidden = rows.length > 0;
    empty.textContent = tr('picker.none', 'No models match “{q}”', { q: search.value.trim() });
    const selected = rows.findIndex((r) => r.value === select.value);
    const again = rows.findIndex((r) => r.value === keepActive && keepActive != null);
    setActive(words.length ? 0 : again !== -1 ? again : selected !== -1 ? selected : 0);
  }
  // Placed against the window, not the sidebar (whose edge would clip it): under the button, or above it
  // when there's more room there, and never past the window's sides.
  function place() {
    const b = button.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 16);
    const below = window.innerHeight - b.bottom - 12;
    const above = b.top - 12;
    const up = below < 260 && above > below;
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(b.left, window.innerWidth - width - 8))}px`;
    menu.style.maxHeight = `${Math.max(180, Math.min(440, up ? above : below))}px`;
    menu.style.top = up ? '' : `${b.bottom + 6}px`;
    menu.style.bottom = up ? `${window.innerHeight - b.top + 6}px` : '';
    menu.classList.toggle('up', up);
  }
  function close(refocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', close);
    if (refocus) button.focus();
  }
  function outside(e) { if (!menu.contains(e.target) && e.target !== button && !button.contains(e.target)) close(false); }
  function choose(value) {
    if (value == null) return;
    close();
    if (!select.querySelector(`option[value="${CSS.escape(value)}"]`)?.dataset.more) remember(value);
    if (select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function open(initial = '') {
    expanded = new Set();
    const many = options().length > 7;
    search.hidden = !many;
    search.value = initial;
    search.placeholder = tr('picker.search', 'Search models');
    search.setAttribute('aria-label', tr('picker.search', 'Search models'));
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    place();
    render();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    (many ? search : list).focus({ preventScroll: true });
    if (!many) list.tabIndex = -1;
  }
  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  button.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
  });
  search.addEventListener('input', () => { expanded = new Set(); render(); });
  const page = () => Math.max(1, Math.floor(list.clientHeight / 40));
  function onKey(e) {
    if (e.key === 'ArrowDown') setActive(active + 1);
    else if (e.key === 'ArrowUp') setActive(active - 1);
    else if (e.key === 'PageDown') setActive(active + page());
    else if (e.key === 'PageUp') setActive(active - page());
    else if ((e.key === 'Home' || e.key === 'End') && (e.target !== search || !search.value)) setActive(e.key === 'Home' ? 0 : rows.length - 1);
    else if (e.key === 'Enter') { const r = rows[active]; if (r?.expand != null) { expanded.add(r.expand); render(); } else if (r) choose(r.value); }
    else if (e.key === 'Escape') { if (search.value) { search.value = ''; render(); } else close(); }
    else if (e.key === 'Tab') { close(false); return; }
    else if (e.target !== search && !search.hidden && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { search.focus(); return; }
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  menu.addEventListener('keydown', onKey);
  sync();
  return { button, menu, sync };
};
