// A themed menu for a <select> (the model pickers). Native select popups are drawn by the OS and don't
// always follow Lumen's theme, so the list is drawn in the page instead. The <select> stays in the DOM
// (visually hidden) as the source of truth: set .value or dispatch 'change' as before, and call
// select.pickerSync() after changing .value from script.
//
// Built for long lists (a few providers can bring 50+ models): a search field once there are more than a
// handful (forgiving: "gpt5" finds GPT-5, best matches first), provider headings that stay in view while their
// models scroll, the last few picks at the top, long groups folded to their first five ("Show all 14"), and one
// compact row per model: its readable name, a note when there is one, and badges ("chat only", "preview",
// "sign in"). An <option> may carry data-name, data-provider (the button's short tag), data-detail and
// data-badges (comma separated); otherwise its text is the name.
// Keyboard: the search field (or, for a short list, the list itself) owns aria-activedescendant: Up/Down,
// PageUp/PageDown, Home/End move, Enter picks, Esc clears the search, then closes. Typing searches.
//
// options: label(o) (the button's text, overriding provider + name), recentKey (share recent picks), extra()
// (rows added at the end: [{ label, detail, run }], e.g. "Search every OpenRouter model"), anchor (open under
// another element; the picker's own button is then hidden).
window.lumenPicker = (select, { label = null, recentKey = null, extra = null, anchor = null } = {}) => {
  const uid = `pk${Math.random().toString(36).slice(2, 8)}`;
  const nameOf = (o) => o.dataset.name || o.textContent;
  const groupOf = (o) => (o.parentElement?.tagName === 'OPTGROUP' ? o.parentElement.label : '');
  const tr = (key, fallback, vars) => {
    let s = window.t ? window.t(key, vars) : key;
    if (!s || s === key) s = fallback;
    return vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') : s;
  };
  const baseLabel = select.getAttribute('aria-label') || '';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'picker-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', `${uid}-list`);
  const where = Object.assign(document.createElement('span'), { className: 'picker-provider' });
  const text = Object.assign(document.createElement('span'), { className: 'picker-text' });
  button.append(where, text);
  if (anchor) button.hidden = true;
  const menu = Object.assign(document.createElement('div'), { className: 'picker-menu', hidden: true });
  const search = Object.assign(document.createElement('input'), { type: 'search', className: 'picker-search', autocomplete: 'off', spellcheck: false });
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-controls', `${uid}-list`);
  search.setAttribute('aria-expanded', 'true');
  search.setAttribute('aria-autocomplete', 'list');
  const list = Object.assign(document.createElement('div'), { className: 'picker-list', id: `${uid}-list`, tabIndex: -1 });
  list.setAttribute('role', 'listbox');
  if (baseLabel) list.setAttribute('aria-label', baseLabel);
  const empty = Object.assign(document.createElement('div'), { className: 'picker-empty', hidden: true });
  empty.setAttribute('role', 'status'); // "No models match" and "Loading" are announced
  menu.append(search, list);
  let loading = false;
  select.classList.add('picker-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.after(button, menu);

  const sync = () => {
    const option = select.selectedOptions[0];
    const name = option ? nameOf(option) : '';
    // The short provider tag, unless the name already says it ("Claude Code" under Claude Code).
    const tag = option ? option.dataset.provider || groupOf(option) : '';
    if (label) { where.textContent = ''; text.textContent = option ? label(option) : ''; }
    else { where.textContent = tag && !name.toLowerCase().startsWith(tag.toLowerCase()) ? tag : ''; text.textContent = name; }
    where.hidden = !where.textContent || select.querySelectorAll('optgroup').length < 2;
    button.title = option ? [groupOf(option), name, option.value].filter(Boolean).join(' · ') : '';
    button.setAttribute('aria-label', [baseLabel, where.hidden ? '' : where.textContent, text.textContent].filter(Boolean).join(': '));
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => button.classList.toggle('picker-narrow', button.clientWidth < 150)).observe(button);
  select.pickerSync = sync;
  select.addEventListener('change', sync);
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true });

  // The last few picks, per picker (localStorage: a convenience only, so every access is guarded).
  const storeKey = recentKey ? `lumen.picker.recent.${recentKey}` : null;
  const recent = () => { try { return storeKey ? JSON.parse(localStorage.getItem(storeKey) || '[]').filter((v) => typeof v === 'string') : []; } catch { return []; } };
  const remember = (value) => { try { if (storeKey) localStorage.setItem(storeKey, JSON.stringify([value, ...recent().filter((v) => v !== value)].slice(0, 6))); } catch { /* not kept */ } };

  let rows = []; // the rows on show, in order: { el, value?, expand?, run? }
  let active = -1;
  let expanded = new Set(); // groups opened past their first five
  let focusValue = null; // after a re-render, the row to make active (e.g. the first model a "Show all" revealed)
  const options = () => [...select.querySelectorAll('option')];
  const owner = () => (search.hidden ? list : search);
  const LONG = 6;
  const SHOWN = 5;

  function setActive(i, scroll = true) {
    if (!rows.length) { active = -1; owner().removeAttribute('aria-activedescendant'); return; }
    active = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((r, k) => r.el.classList.toggle('active', k === active));
    owner().setAttribute('aria-activedescendant', rows[active].el.id);
    if (scroll) rows[active].el.scrollIntoView({ block: 'nearest' }); // the list's scroll-padding keeps it clear of the sticky heading
  }
  const hold = (el) => el.addEventListener('pointerdown', (e) => e.preventDefault()); // keeps the focus where it is
  const BADGES = { 'chat only': ['picker.badge.chatOnly', 'chat only'], preview: ['picker.badge.preview', 'preview'], 'sign in': ['picker.badge.signIn', 'sign in'], experimental: ['picker.badge.experimental', 'experimental'] };
  const badgeText = (b) => (BADGES[b] ? tr(BADGES[b][0], BADGES[b][1]) : b);
  let recentRow = false;
  function row(o, key) {
    const el = Object.assign(document.createElement('div'), { className: 'picker-item', id: `${uid}-${key}` });
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', String(o.selected));
    const top = Object.assign(document.createElement('span'), { className: 'picker-line' });
    top.append(Object.assign(document.createElement('span'), { className: 'picker-name', textContent: nameOf(o) }));
    const badges = (o.dataset.badges || '').split(',').map((x) => x.trim()).filter(Boolean);
    for (const b of badges) {
      top.append(Object.assign(document.createElement('span'), { className: `picker-badge${b === 'sign in' ? ' warn' : ''}`, textContent: badgeText(b) }));
    }
    el.append(top);
    // A recent pick says where it is from ("OpenAI"), since it sits outside its provider's heading.
    const detail = [recentRow ? o.dataset.provider || groupOf(o) : '', o.dataset.detail || ''].filter(Boolean).join(' · ');
    if (detail) el.append(Object.assign(document.createElement('span'), { className: 'picker-detail', textContent: detail }));
    el.title = [nameOf(o), o.dataset.more ? '' : o.value, o.title && o.title !== detail ? o.title : ''].filter(Boolean).join('\n');
    el.setAttribute('aria-label', [nameOf(o), ...badges.map(badgeText), detail].filter(Boolean).join(', ')); // what a screen reader says
    hold(el);
    el.addEventListener('click', () => choose(o.value));
    el.addEventListener('pointermove', () => { const k = rows.findIndex((r) => r.el === el); if (k !== active) setActive(k, false); });
    rows.push({ el, value: o.value });
    return el;
  }
  function actionRow(key, textContent, detail, handler, cls = 'picker-more') {
    const el = Object.assign(document.createElement('div'), { className: `picker-item ${cls}`, id: `${uid}-${key}` });
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', 'false');
    el.append(Object.assign(document.createElement('span'), { className: 'picker-line', textContent }));
    if (detail) el.append(Object.assign(document.createElement('span'), { className: 'picker-detail', textContent: detail }));
    hold(el);
    el.addEventListener('click', handler);
    return el;
  }
  function heading(textContent, count) {
    const h = Object.assign(document.createElement('div'), { className: 'picker-group' });
    h.setAttribute('role', 'presentation');
    h.append(Object.assign(document.createElement('span'), { textContent }));
    if (count) h.append(Object.assign(document.createElement('span'), { className: 'picker-count', textContent: String(count) }));
    return h;
  }
  // Search: every word must appear somewhere (name, id, provider, note, badges), punctuation ignored ("gpt5" finds
  // "GPT-5"); a name that starts with the query ranks first, then a word that does, then anything else.
  // Matching is by the start of words (and of the letters/digits inside them: "5" finds "GPT-5.6", "mini" does not
  // find "Gemini"), in the name, id, provider and badges, with punctuation ignored ("gpt5" finds "GPT-5").
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const tokens = (s) => String(s).toLowerCase().split(/[^a-z0-9]+|(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/).filter(Boolean);
  const starts = (field, w) => { const n = norm(w); return Boolean(n) && (norm(field).startsWith(n) || tokens(field).some((t) => t.startsWith(n))); };
  function score(o, words) {
    if (!words.length) return 1;
    const name = nameOf(o);
    const group = `${groupOf(o)} ${o.dataset.provider || ''}`;
    const fields = [name, o.value.replace(/^[a-z]+:/, ''), group, (o.dataset.badges || '').replace(/,/g, ' ')];
    if (!words.every((w) => fields.some((f) => starts(f, w)))) return 0;
    if (words.every((w) => starts(group, w))) return 4; // "claude" puts the Claude group first
    const q = words.join(' ');
    if (norm(name).startsWith(norm(q))) return 3;
    return words.every((w) => starts(name, w)) ? 2 : 1;
  }
  function render() {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const all = options();
    const keepActive = focusValue ?? rows[active]?.value;
    focusValue = null;
    rows = [];
    const out = [];
    // The last picks first (not while searching, and only when the list is long enough to need them), without
    // the current one, which is marked in its group anyway.
    if (!words.length && all.length > 7) {
      const recents = recent().map((v) => all.find((o) => o.value === v)).filter((o) => o && !o.dataset.more && !o.selected).slice(0, 3);
      if (recents.length) {
        out.push(heading(tr('picker.recent', 'Recent')));
        recentRow = true;
        recents.forEach((o, i) => out.push(row(o, `r${i}`)));
        recentRow = false;
      }
    }
    const groups = new Map();
    for (const o of all) {
      const sc = score(o, words);
      if (!sc) continue;
      const g = groupOf(o);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ o, sc });
    }
    let ordered = [...groups];
    if (words.length) {
      for (const [, members] of ordered) members.sort((a, b) => b.sc - a.sc);
      ordered = ordered.sort((a, b) => Math.max(...b[1].map((m) => m.sc)) - Math.max(...a[1].map((m) => m.sc)));
    }
    let n = 0;
    for (const [g, all2] of ordered) {
      // An action row ("More models…") is not a model: it is never folded away or counted.
      const members = all2.filter((m) => !m.o.dataset.more);
      const actions = all2.filter((m) => m.o.dataset.more);
      const section = Object.assign(document.createElement('div'), { className: 'picker-section' });
      section.setAttribute('role', 'group');
      if (g && (ordered.length > 1 || out.length)) { const h = heading(g, members.length > SHOWN ? members.length : 0); h.id = `${uid}-g${n}`; section.setAttribute('aria-labelledby', h.id); section.append(h); }
      const folded = !words.length && members.length > LONG && !expanded.has(g) && !members.slice(SHOWN).some((m) => m.o.selected);
      (folded ? members.slice(0, SHOWN) : members).forEach((m, i) => section.append(row(m.o, `${n}-${i}`)));
      actions.forEach((m, i) => section.append(row(m.o, `${n}-a${i}`)));
      if (folded) {
        const reveal = members[SHOWN].o.value;
        const more = actionRow(`m${n}`, tr('picker.showAll', 'Show all {n}', { n: members.length }), '', () => { expanded.add(g); focusValue = reveal; render(); });
        rows.push({ el: more, expand: g, reveal });
        section.insertBefore(more, section.children[SHOWN + (section.firstElementChild?.classList.contains('picker-group') ? 1 : 0)] || null);
      }
      out.push(section);
      n++;
    }
    const anyModel = rows.some((r) => r.value != null);
    empty.hidden = anyModel || !words.length;
    empty.textContent = loading ? tr('picker.loading', 'Loading models…') : tr('picker.none', 'No models match “{q}”', { q: search.value.trim() });
    if (loading) empty.hidden = false;
    out.push(empty); // right after the models, before any extra rows
    for (const [i, x] of (extra?.(search.value.trim()) || []).entries()) {
      const el = actionRow(`x${i}`, x.label, x.detail || '', () => { close(); x.run(search.value.trim()); }, 'picker-more picker-extra');
      rows.push({ el, run: x.run });
      out.push(el);
    }
    list.replaceChildren(...out);
    const selected = rows.findIndex((r) => r.value === select.value);
    const again = keepActive != null ? rows.findIndex((r) => r.value === keepActive) : -1;
    setActive(words.length ? 0 : again !== -1 ? again : selected !== -1 ? selected : 0);
  }
  // Placed against the window (fixed), inside whatever clips the picker's surroundings (the sidebar, whose edge
  // the page view is drawn over): under the button, or above it when there's more room there.
  function clipBox() {
    for (let el = button.parentElement; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.overflow !== 'visible' || cs.overflowX !== 'visible') return el.getBoundingClientRect();
    }
    return { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
  }
  function place() {
    const b = (anchor || button).getBoundingClientRect();
    const box = clipBox();
    const left0 = Math.max(0, box.left) + 8;
    const right0 = Math.min(window.innerWidth, box.right) - 8;
    const width = Math.max(220, Math.min(360, right0 - left0));
    const below = window.innerHeight - b.bottom - 12;
    const above = b.top - 12;
    const up = below < 260 && above > below;
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(left0, Math.min(b.left, right0 - width))}px`;
    menu.style.maxHeight = `${Math.max(180, Math.min(460, up ? above : below))}px`;
    menu.style.top = up ? '' : `${b.bottom + 6}px`;
    menu.style.bottom = up ? `${window.innerHeight - b.top + 6}px` : '';
    menu.classList.toggle('up', up);
  }
  function close(refocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (anchor) anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', onResize);
    if (refocus) (anchor || button).focus();
  }
  const onResize = () => close(false);
  function outside(e) { if (!menu.contains(e.target) && e.target !== button && !button.contains(e.target) && !(anchor && anchor.contains(e.target))) close(false); }
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
    rows = []; // a reopened list starts at the current model, not wherever the pointer or arrows last were
    active = -1;
    focusValue = null;
    const many = options().length > 7 || Boolean(anchor);
    search.hidden = !many;
    search.value = initial;
    search.placeholder = tr('picker.search', 'Search models');
    search.setAttribute('aria-label', tr('picker.search', 'Search models'));
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    place();
    render();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', onResize);
    owner().focus({ preventScroll: true });
    if (anchor) {
      anchor.setAttribute('aria-expanded', 'true');
      anchor.lumenAnchoredClose = () => { if (menu.hidden) return false; close(); return true; };
    }
  }
  // A click on this button while another list is open under it (OpenRouter's catalog) only closes that list.
  button.addEventListener('click', () => { if (button.lumenAnchoredClose?.()) return; if (menu.hidden) open(); else close(); });
  button.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
  });
  search.addEventListener('input', () => { expanded = new Set(); render(); });
  const page = () => Math.max(1, Math.floor(list.clientHeight / 44));
  function onKey(e) {
    if (e.key === 'ArrowDown') setActive(active + 1);
    else if (e.key === 'ArrowUp') setActive(active - 1);
    else if (e.key === 'PageDown') setActive(active + page());
    else if (e.key === 'PageUp') setActive(active - page());
    else if ((e.key === 'Home' || e.key === 'End') && (e.target !== search || !search.value)) setActive(e.key === 'Home' ? 0 : rows.length - 1);
    else if (e.key === 'Enter') { rows[active]?.el.click(); }
    else if (e.key === 'Escape') { if (search.value) { search.value = ''; render(); } else close(); }
    else if (e.key === 'Tab') { close(false); return; }
    else if (e.target !== search && !search.hidden && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { search.focus(); return; }
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  menu.addEventListener('keydown', onKey);
  sync();
  // setLoading(true): the list says it is loading (the OpenRouter catalog's first fetch); refresh(): redraw if open.
  return { button, menu, sync, open, close, setLoading: (on) => { loading = Boolean(on); if (!menu.hidden) render(); }, refresh: () => { if (!menu.hidden) render(); } };
};
