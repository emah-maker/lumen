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
// another element; the picker's own button is then hidden), onMore(value) (an option with data-more is an action,
// "More models…": it runs this and never becomes the value), filters ([{ key, label, test(option) }]: chips under the
// search field, each narrowing the list), wide (a wider menu, for long catalog names).
window.lumenPicker = (select, { label = null, recentKey = null, extra = null, anchor = null, title = null, onBack = null, placeholder = null, headings = false, onMore = null, filters = [], wide = false } = {}) => {
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
  // A heading for a list opened from another one (OpenRouter's catalog): what it is, how many, and a way back.
  const head = Object.assign(document.createElement('div'), { className: 'picker-head', hidden: !title });
  if (title) {
    if (onBack) {
      const back = Object.assign(document.createElement('button'), { type: 'button', className: 'picker-back', textContent: '‹' });
      back.setAttribute('aria-label', tr('picker.back', 'Back to the short list'));
      back.addEventListener('click', () => { const q = search.value; close(false); onBack(q); });
      head.append(back);
    }
    head.append(Object.assign(document.createElement('span'), { className: 'picker-title' }));
  }
  // What a search found, for screen readers ("12 models", "No models match …"), in one live region that stays put.
  const live = Object.assign(document.createElement('span'), { className: 'picker-sr' });
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  // Filter chips (the OpenRouter catalog: Free, Can act in tabs, 128K+ context): toggles, several at once.
  const on = new Set();
  const chips = Object.assign(document.createElement('div'), { className: 'picker-chips', hidden: !filters.length });
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', tr('picker.filters', 'Filters'));
  for (const f of filters) {
    const chip = Object.assign(document.createElement('button'), { type: 'button', className: 'picker-chip', textContent: f.label });
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('pointerdown', (e) => e.preventDefault()); // the search field keeps the focus
    chip.addEventListener('click', () => {
      if (on.has(f.key)) on.delete(f.key); else on.add(f.key);
      chip.setAttribute('aria-pressed', String(on.has(f.key)));
      expanded = new Set();
      render();
    });
    chips.append(chip);
  }
  const passes = (o) => o.dataset.more || filters.every((f) => !on.has(f.key) || f.test(o));
  menu.append(head, search, chips, list, live);
  let loading = false;
  let slow = false; // the first load has taken more than 3 s
  let slowTimer = 0;
  let centreNext = false; // on open, the current model is scrolled to the middle, with its neighbours in view
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
    requestAnimationFrame(fitTag); // a new name (or the list reloaded): shortened again to the room there is
  };
  // The provider tag shows when the header has room for tag and name together (measured against the space the
  // picker's row leaves it, not the button's own width, which the tag itself changes).
  const shortName = (n) => String(n).replace(/\s+(Fast|Reasoning|Non-Reasoning|Latest|Instruct|Experimental|Preview)\b/g, '').replace(/^Claude\s+/, '').trim() || n;
  function fitTag() {
    const wrap = button.parentElement;
    const row = wrap?.parentElement;
    if (!row || where.hidden || !where.textContent) { button.classList.remove('picker-narrow'); return; }
    const others = [...row.children].filter((c) => c !== wrap).reduce((w, c) => w + c.offsetWidth, 0);
    const cs = getComputedStyle(row);
    const room = row.clientWidth - others - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0) - 8;
    // A name too long for the room: its least telling words go first (the version always stays).
    const full = nameOf(select.selectedOptions[0] || { dataset: {}, textContent: '' });
    text.textContent = full;
    if (text.scrollWidth + 30 > room) text.textContent = shortName(full);
    button.classList.remove('picker-narrow');
    const need = where.scrollWidth + text.scrollWidth + 30; // the tag, the name, the gap and the arrow
    button.classList.toggle('picker-narrow', need > Math.min(room, 320));
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(fitTag).observe(button.parentElement?.parentElement || button);
  select.addEventListener('change', () => requestAnimationFrame(fitTag));
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

  let activeEl = null;
  function setActive(i, scroll = true) {
    if (!rows.length) { active = -1; activeEl?.classList.remove('active'); activeEl = null; owner().removeAttribute('aria-activedescendant'); return; }
    active = Math.max(0, Math.min(rows.length - 1, i));
    if (activeEl !== rows[active].el) { activeEl?.classList.remove('active'); activeEl = rows[active].el; activeEl.classList.add('active'); }
    owner().setAttribute('aria-activedescendant', rows[active].el.id);
    if (scroll) rows[active].el.scrollIntoView({ block: centreNext ? 'center' : 'nearest' }); // the list's scroll-padding keeps it clear of the sticky heading
    centreNext = false;
  }
  // One set of listeners on the list, not three per row (a catalog has hundreds): what a row does is kept here.
  const act = new WeakMap(); // row -> what a click does
  list.addEventListener('pointerdown', (e) => { if (e.target.closest('.picker-item')) e.preventDefault(); }); // keeps the focus where it is
  list.addEventListener('click', (e) => { const el = e.target.closest('.picker-item'); if (el) act.get(el)?.(); });
  list.addEventListener('pointermove', (e) => {
    const el = e.target.closest('.picker-item');
    if (!el || el === activeEl) return;
    const k = rows.findIndex((r) => r.el === el);
    if (k !== -1) setActive(k, false);
  });
  const BADGES = { free: ['picker.badge.free', 'free'], 'chat only': ['picker.badge.chatOnly', 'chat only'], preview: ['picker.badge.preview', 'preview'], 'sign in': ['picker.badge.signIn', 'sign in'], experimental: ['picker.badge.experimental', 'experimental'] };
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
    const maker = recentRow ? o.dataset.provider || groupOf(o) : '';
    const detail = [maker && !String(o.dataset.detail || '').startsWith(maker) ? maker : '', o.dataset.detail || ''].filter(Boolean).join(' · ');
    if (detail) el.append(Object.assign(document.createElement('span'), { className: 'picker-detail', textContent: detail }));
    el.title = [nameOf(o), o.dataset.more ? '' : o.value, o.title && o.title !== detail ? o.title : ''].filter(Boolean).join('\n');
    el.setAttribute('aria-label', [nameOf(o), ...badges.map(badgeText), detail].filter(Boolean).join(', ')); // what a screen reader says
    if (usageBars) decorateUsage(el, top, usageBars.forModel(o.value, usageBars.state()), o);
    act.set(el, () => choose(o.value));
    rows.push({ el, value: o.value });
    return el;
  }
  // [usage bars] renderer/usage-bars.js: a provider's plan window next to its heading (or its rows, when there is no
  // heading), and a model that is out of usage marked on its own row. All of it is absent when there is no data.
  const usageBars = window.usageBars;
  let usageRows = false;
  function decorateUsage(el, top, desc, o) {
    if (!desc || !(usageRows || desc.out)) return; // (a row under a heading that has the bar carries one only when it is out)
    top.append(usageBars.element(desc, { label: tr('usage.bar.labelFor', '{name} usage', { name: nameOf(o) }) }));
    if (desc.out) el.classList.add('picker-out');
    el.setAttribute('aria-label', `${el.getAttribute('aria-label')}, ${desc.valuetext}`);
  }
  function actionRow(key, textContent, detail, handler, cls = 'picker-more') {
    const el = Object.assign(document.createElement('div'), { className: `picker-item ${cls}`, id: `${uid}-${key}` });
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', 'false');
    el.append(Object.assign(document.createElement('span'), { className: 'picker-line', textContent }));
    if (detail) el.append(Object.assign(document.createElement('span'), { className: 'picker-detail', textContent: detail }));
    act.set(el, handler);
    return el;
  }
  // The provider's plan bar at the end of its heading; the models that are out of usage are marked on their rows.
  function decorateHeading(h, o) {
    const desc = o && usageBars ? usageBars.forProvider(usageBars.providerOf(o.value), usageBars.state()) : null;
    if (!desc) return;
    h.classList.add('has-ubar');
    h.append(usageBars.element(desc, { label: tr('usage.bar.labelFor', '{name} usage', { name: h.firstChild.textContent }) }));
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
  // Search: every word must start a word somewhere (renderer/picker-match.js), best matches first.
  const PM = window.pickerMatch;
  // A price or size word ("$3", "$0.3", "128k", "1m") is compared by value with the row's own price and context
  // (picker-match.js unitMatches), never with names or versions ("$3" is not Claude 3).
  const unitWord = PM.unitWord;
  const rawOf = (o) => ({
    price: o.dataset.price !== undefined && o.dataset.price !== '' ? Number(o.dataset.price) : undefined,
    context: Number(o.dataset.context) || 0,
    free: (o.dataset.badges || '').split(',').includes('free'),
  });
  const score = (o, words) => {
    const units = words.filter(unitWord);
    if (units.length) { const raw = rawOf(o); if (!units.every((w) => PM.unitMatches(w, raw))) return 0; }
    const rest = words.filter((w) => !unitWord(w));
    if (!rest.length) return units.length ? 2 : 1;
    return PM.score({
      name: nameOf(o), id: o.value.replace(/^[a-z]+:/, ''),
      group: `${o.parentElement?.dataset?.search ?? groupOf(o)} ${o.dataset.provider || ''}`.trim(),
      badges: (o.dataset.badges || '').replace(/,/g, ' '),
    }, rest.join(' '));
  };
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
      const recents = recent().map((v) => all.find((o) => o.value === v)).filter((o) => o && !o.dataset.more && !o.selected && passes(o)).slice(0, 3);
      if (recents.length) {
        // A section like a vendor's, so its sticky heading gives way to the next one as the list scrolls.
        const section = Object.assign(document.createElement('div'), { className: 'picker-section picker-recent' });
        section.setAttribute('role', 'group');
        const h = heading(tr('picker.recent', 'Recent'));
        h.id = `${uid}-gr`;
        section.setAttribute('aria-labelledby', h.id);
        section.append(h);
        recentRow = true;
        usageRows = true;
        recents.forEach((o, i) => section.append(row(o, `r${i}`)));
        recentRow = false;
        usageRows = false;
        out.push(section);
      }
    }
    const groups = new Map();
    for (const o of all) {
      if (!passes(o)) continue;
      const sc = score(o, words);
      if (!sc) continue;
      const g = groupOf(o);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ o, sc });
    }
    const matched = [...groups.values()].reduce((k, ms) => k + ms.filter((m) => !m.o.dataset.more).length, 0); // before folding
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
      usageRows = !(g && (headings || words.length || ordered.length > 1 || out.length)); // no heading to carry the provider's bar: each row does
      if (!usageRows) { const h = heading(g, headings || members.length > SHOWN ? members.length : 0); h.id = `${uid}-g${n}`; section.setAttribute('aria-labelledby', h.id); decorateHeading(h, members[0] && members[0].o); section.append(h); }
      const folded = !words.length && members.length > LONG && !expanded.has(g) && !members.slice(SHOWN).some((m) => m.o.selected);
      (folded ? members.slice(0, SHOWN) : members).forEach((m, i) => section.append(row(m.o, `${n}-${i}`)));
      if (folded) {
        const reveal = members[SHOWN].o.value;
        const more = actionRow(`m${n}`, tr('picker.showMore', 'Show {n} more', { n: members.length - SHOWN }), '', () => { expanded.add(g); focusValue = reveal; render(); });
        rows.push({ el: more, expand: g, reveal });
        section.append(more);
      }
      actions.forEach((m, i) => { const r = row(m.o, `${n}-a${i}`); r.classList.add('picker-foot'); section.append(r); });
      section.style.containIntrinsicSize = `auto ${section.childElementCount * 40 + 8}px`; // about its real height, until drawn
      out.push(section);
      n++;
    }
    const anyModel = rows.some((r) => r.value != null);
    const extras = extra?.(search.value.trim()) || [];
    empty.hidden = anyModel || (!words.length && !on.size) || extras.length > 0; // a "Look for … on OpenRouter" row says it better
    empty.textContent = loading ? tr('picker.loading', 'Loading models…') : words.length ? tr('picker.none', 'No models match “{q}”', { q: search.value.trim() }) : tr('picker.noneFiltered', 'No models match these filters');
    if (loading) empty.hidden = false;
    out.push(empty); // right after the models, before any extra rows
    const found = matched;
    const said = loading ? empty.textContent : words.length || on.size ? (found === 1 ? tr('picker.countOne', '1 model') : found ? tr('picker.count', '{n} models', { n: found }) : empty.textContent) : '';
    if (live.textContent !== said) live.textContent = said;
    const total = all.filter((o) => !o.dataset.more).length;
    // Narrowed by a search or a filter: how many of all match ("37 of 412").
    if (title) head.querySelector('.picker-title').textContent = loading ? (slow ? tr('picker.slow', 'Still loading… OpenRouter is slow to answer') : tr('picker.loading', 'Loading models…')) : tr(title, title, { n: words.length || on.size ? tr('picker.of', '{n} of {total}', { n: matched, total }) : total });
    for (const [i, x] of extras.entries()) {
      const el = actionRow(`x${i}`, x.label, x.detail || '', () => { close(); x.run(search.value.trim()); }, 'picker-more picker-extra');
      rows.push({ el, run: x.run });
      out.push(el);
    }
    list.replaceChildren(...out);
    const selected = rows.findIndex((r) => r.value === select.value);
    const again = keepActive != null ? rows.findIndex((r) => r.value === keepActive) : -1;
    setActive(words.length && !keepHighlight ? 0 : again !== -1 ? again : words.length ? 0 : selected !== -1 ? selected : 0);
    keepHighlight = false;
  }
  let keepHighlight = false; // (set by refresh(): the list changed under the user, the highlight stays put)
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
    const width = Math.max(220, Math.min(wide ? 420 : 360, right0 - left0));
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
    window.removeEventListener('scroll', onScroll, true);
    if (refocus) (anchor || button).focus();
  }
  const onResize = () => close(false);
  const onScroll = (e) => { if (!menu.contains(e.target) && (e.target === document || e.target.contains?.(anchor || button))) close(false); };
  function outside(e) { if (!menu.contains(e.target) && e.target !== button && !button.contains(e.target) && !(anchor && anchor.contains(e.target))) close(false); }
  function choose(value) {
    if (value == null) return;
    const more = select.querySelector(`option[value="${CSS.escape(value)}"]`)?.dataset.more;
    if (more && onMore) { close(false); onMore(value); return; } // an action, not a value: the button never shows it
    close();
    if (!more) remember(value);
    if (select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function open(initial = '') {
    expanded = new Set();
    on.clear();
    for (const c of chips.children) c.setAttribute('aria-pressed', 'false');
    rows = []; // a reopened list starts at the current model, not wherever the pointer or arrows last were
    active = -1;
    focusValue = null;
    const many = options().length > 7 || Boolean(anchor);
    search.hidden = !many;
    search.value = initial;
    search.placeholder = placeholder || tr('picker.search', 'Search models');
    search.setAttribute('aria-label', tr('picker.search', 'Search models'));
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    usageBars?.touch(); // the cached usage numbers, at most every few seconds; the list redraws if they changed
    place();
    centreNext = true;
    render();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true); // the page moved under it (Settings scrolls): it closes, as a native one does
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
  let typing = 0;
  search.addEventListener('input', () => {
    expanded = new Set();
    clearTimeout(typing);
    if (options().length > 80) typing = setTimeout(render, 50); else render();
  });
  const page = () => Math.max(1, Math.floor(list.clientHeight / 44));
  function onKey(e) {
    const onControl = e.target.closest?.('.picker-chip, .picker-back');
    if (onControl && (e.key === 'Enter' || e.key === ' ')) return; // the button's own click
    if (onControl && /^(Arrow(Up|Down)|Page(Up|Down)|Home|End)$/.test(e.key)) owner().focus(); // the list's keys: the highlight is announced there
    if (e.key === 'ArrowDown') setActive(active + 1);
    else if (e.key === 'ArrowUp') setActive(active - 1);
    else if (e.key === 'PageDown') setActive(active + page());
    else if (e.key === 'PageUp') setActive(active - page());
    else if ((e.key === 'Home' || e.key === 'End') && (e.target !== search || !search.value)) setActive(e.key === 'Home' ? 0 : rows.length - 1);
    else if (e.key === 'Enter') { rows[active]?.el.click(); }
    else if (e.key === 'Escape') { if (search.value) { search.value = ''; render(); } else if (onBack) { close(false); onBack(); } else close(); }
    else if (e.key === 'Tab' && (head.querySelector('.picker-back') || filters.length)) {
      // Around Back, the search field and the chips, instead of leaving the list.
      const stops = [head.querySelector('.picker-back'), owner(), ...chips.children].filter((x) => x && !x.hidden);
      const at = stops.indexOf(document.activeElement);
      stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
    }
    else if (e.key === 'Tab') { close(false); return; }
    else if (search.hidden && e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // A short list (no search field): a letter jumps to the next model starting with it.
      const k = e.key.toLowerCase();
      const order = [...rows.slice(active + 1), ...rows.slice(0, active + 1)];
      const hit = order.find((r) => r.value != null && r.el.textContent.trim().toLowerCase().startsWith(k));
      if (hit) setActive(rows.indexOf(hit));
    }
    else if (e.target !== search && !search.hidden && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { search.focus(); return; }
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  menu.addEventListener('keydown', onKey);
  // The list keeps its own scroll (overscroll-behavior in picker.css); a wheel over the heading, search or chips
  // doesn't scroll the page behind, which would close the menu.
  menu.addEventListener('wheel', (e) => {
    const atEnd = e.deltaY < 0 ? list.scrollTop <= 0 : list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
    if (!list.contains(e.target) || list.scrollHeight <= list.clientHeight || atEnd) e.preventDefault();
  }, { passive: false });
  sync();
  window.addEventListener('lumen-usage-bars', () => { if (!menu.hidden) { keepHighlight = true; render(); } });
  // setLoading(true): the list says it is loading (the OpenRouter catalog's first fetch); refresh(): redraw if open.
  return { button, menu, sync, open, close, setLoading: (v) => { loading = Boolean(v); slow = false; clearTimeout(slowTimer); if (loading) slowTimer = setTimeout(() => { slow = true; if (!menu.hidden) render(); }, 3000); if (!menu.hidden) render(); }, refresh: () => { if (!menu.hidden) { keepHighlight = true; render(); } } };
};
