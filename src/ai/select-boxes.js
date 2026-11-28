// [select boxes] Choosing an option in a dropdown by its visible text, in one call (fill_form with the field's label and the option, or click
// with the option's text). Native <select>s get the option set directly (no OS popup the AI can't see); custom comboboxes and listboxes
// (ARIA combobox / listbox / option: MUI, React-Select, Headless UI, Select2, …) are opened with a real click, then the list is searched:
// what is rendered, then typed into when the box filters as you type, then scrolled through (a virtualized list renders only what is in view),
// waiting for options that load after opening. The option is clicked like any element (the AI's cursor and per-tool timing included), and the
// field is read back to confirm it shows the option. A value that is not there gets an error naming the options that are.
// Loaded on first use (agent.js lazy: startup budget).
const { HELPERS } = require('./page-scripts');
const frames = require('./frames');

// The option `want` names, among options [{ text, value }]: its index, or -1. Exact text, then exact value, then the same letters and digits
// (case, accents and punctuation aside), then a unique prefix, then a unique word-start match, then a unique substring. Several prefix or substring
// matches: the shortest (“Iran” for “Ira” rather than “Iraq”… a tie stays the first). exactOnly: only the exact steps (a list seen a part at a
// time, where a looser match in view may not be the best one in the whole list). Self-contained: it is also put into page scripts.
function matchOption(options, want, exactOnly = false) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  const loose = (s) => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const w = norm(want);
  if (!w) return -1;
  const texts = options.map((o) => norm(o && o.text));
  let i = texts.indexOf(w);
  if (i >= 0) return i;
  i = options.findIndex((o) => o && o.value != null && norm(o.value) === w);
  if (i >= 0) return i;
  const lw = loose(w);
  if (!lw) return -1;
  const looseTexts = texts.map(loose);
  i = looseTexts.indexOf(lw);
  if (i < 0) i = looseTexts.findIndex((t) => t.replace(/ /g, '') === lw.replace(/ /g, '')); // “Côte d’Ivoire” for “cote divoire”
  if (i >= 0 || exactOnly) return i;
  const shortest = (hits) => (hits.length ? hits.reduce((a, b) => (looseTexts[b].length < looseTexts[a].length ? b : a)) : -1);
  const all = looseTexts.map((_, k) => k);
  const prefix = all.filter((k) => looseTexts[k].startsWith(lw));
  if (prefix.length) return shortest(prefix);
  const wordStart = all.filter((k) => (' ' + looseTexts[k]).includes(' ' + lw));
  if (wordStart.length) return shortest(wordStart);
  return shortest(all.filter((k) => looseTexts[k].includes(lw)));
}

// The options named in an error: at most `max`, then how many more.
function optionList(texts, max = 30) {
  const uniq = [...new Set(texts.map((t) => String(t).replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (!uniq.length) return '(no options were shown)';
  const shown = uniq.slice(0, max).map((t) => `"${t.length > 60 ? `${t.slice(0, 59)}…` : t}"`).join(', ');
  return uniq.length > max ? `${shown} … and ${uniq.length - max} more` : shown;
}

// Shared page-side helpers: what kind of box an element is, the list it opened, and what the field shows.
const SELECT_HELPERS = `
  const matchOption = ${matchOption.toString()};
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const shown = (el) => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const s = el.ownerDocument.defaultView.getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const textInput = (el) => Boolean(el) && ((el.tagName === 'INPUT' && /^(text|search|email|url|tel|)$/i.test(el.getAttribute('type') || '') && !el.readOnly && !el.disabled) || (el.tagName === 'TEXTAREA' && !el.readOnly) || el.isContentEditable);
  const SELECT_HINT = /select2-selection|react-select__control|css-[a-z0-9]+-control|MuiSelect|MuiAutocomplete|select__trigger|choices__inner|ts-control|selectize-input|chosen-single|vs__dropdown-toggle|ant-select-selector/i;
  // The combobox an element belongs to (itself, an ancestor marked as one, or a select-like control around it), or null.
  const boxOf = (el) => {
    for (let n = el, depth = 0; n && n.nodeType === 1 && depth < 4; n = n.parentElement, depth++) {
      const role = n.getAttribute('role');
      const popup = (n.getAttribute('aria-haspopup') || '').toLowerCase();
      if (role === 'combobox') return n;
      if (popup === 'listbox' || (depth === 0 && ['true', 'menu', 'tree', 'grid'].includes(popup))) return n;
      if (SELECT_HINT.test(typeof n.className === 'string' ? n.className : '')) return n;
      if (depth === 0 && !['DIV', 'SPAN', 'BUTTON', 'INPUT'].includes(n.tagName)) return null;
    }
    return null;
  };
  // A hidden native <select> a widget stands in for (Select2, Chosen, Choices.js): it holds the real value.
  const nativeBehind = (box) => {
    for (let n = box, depth = 0; n && depth < 4; n = n.parentElement, depth++) {
      const prev = n.previousElementSibling;
      if (prev && prev.tagName === 'SELECT' && !shown(prev)) return prev;
      const inner = n.parentElement && [...n.parentElement.children].find((c) => c.tagName === 'SELECT' && !shown(c));
      if (inner && depth > 0) return inner;
    }
    return null;
  };
  const expandedOf = (box) => {
    for (const n of [box, ...box.querySelectorAll('[aria-expanded]')]) if (n.getAttribute('aria-expanded') === 'true') return true;
    return false;
  };
  const OPTION_SEL = '[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=treeitem]';
  // The popup list a box opened: the one its aria-controls / aria-owns names, else the last shown listbox (a portal at the end of <body>),
  // else a known widget's results list, else a shown menu.
  const listOf = (box) => {
    const doc = box ? box.ownerDocument : document;
    const roots = [doc];
    if (box && box.getRootNode() !== doc) roots.unshift(box.getRootNode());
    if (box) {
      const refs = [box, ...box.querySelectorAll('[aria-controls],[aria-owns]')].flatMap((n) => [n.getAttribute('aria-controls'), n.getAttribute('aria-owns')]).filter(Boolean).flatMap((v) => v.split(/\\s+/));
      for (const ref of refs) for (const root of roots) {
        const list = root.getElementById ? root.getElementById(ref) : null;
        if (list && shown(list) && (list.querySelector(OPTION_SEL) || list.matches('[role=listbox],[role=menu],[role=tree],[role=grid]'))) return list;
      }
    }
    for (const sel of ['[role=listbox]', '.select2-results__options, [class*="menu-list"], [class*="MenuList"], .choices__list--dropdown, .ts-dropdown-content, .chosen-results, .vs__dropdown-menu, .rc-virtual-list', '[role=menu]', '[role=tree]']) {
      const found = [];
      for (const root of roots) for (const n of root.querySelectorAll(sel)) if (shown(n) && (!box || !n.contains(box))) found.push(n);
      if (found.length) return found[found.length - 1];
    }
    return null;
  };
  const optionsIn = (list) => {
    let opts = [...list.querySelectorAll(OPTION_SEL)];
    if (!opts.length) opts = [...list.querySelectorAll('li')];
    // (not a status row: “Loading…”, “No results found”)
    return opts.filter((o) => { const t = norm(o.innerText || o.textContent); return shown(o) && t && !/^(loading|searching|no (results|options|matches)|please wait)/i.test(t); });
  };
  const scrollerOf = (list) => {
    const can = (n) => { const s = n.ownerDocument.defaultView.getComputedStyle(n); return /(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 2; };
    for (let n = list, depth = 0; n && n.nodeType === 1 && depth < 4; n = n.parentElement, depth++) if (can(n)) return n;
    for (const n of list.querySelectorAll('*')) if (can(n)) return n;
    return null;
  };
  // What the field shows now: its value, its text, a hidden native select's choice, and the text of the control around it.
  const textOf = (n) => { // (an open list inside the control, a label or a select's options are not what the field shows)
    if (!n.querySelector('[role=listbox],[role=menu],label,select')) return n.innerText || '';
    const copy = n.cloneNode(true);
    copy.querySelectorAll('[role=listbox],[role=menu],label,select').forEach((l) => l.remove());
    return copy.textContent || '';
  };
  const displayOf = (el) => {
    const box = boxOf(el) || el;
    const parts = [];
    if (el.tagName === 'SELECT') return norm(el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : '');
    for (const n of [el, box]) { if ('value' in n && n.tagName !== 'BUTTON') parts.push(n.value); parts.push(textOf(n)); parts.push(n.getAttribute('aria-valuetext') || ''); }
    const native = nativeBehind(box);
    if (native && native.selectedOptions && native.selectedOptions[0]) parts.push(native.selectedOptions[0].text);
    let around = box.parentElement;
    for (let depth = 0; around && depth < 2; around = around.parentElement, depth++) {
      if (around.querySelectorAll('[role=combobox],select,input:not([type=hidden])').length > 2) break;
      if (around.getBoundingClientRect().height > Math.max(90, box.getBoundingClientRect().height * 3)) break;
      parts.push(textOf(around));
    }
    return parts.map(norm).filter(Boolean).join(' | ');
  };
  const register = (el, chain, label) => {
    const reg = window.__claudeEls || (window.__claudeEls = []);
    const at = reg.findIndex((e) => e && e.el === el);
    if (at >= 0) return at + 1;
    reg.push({ el, chain, label });
    return reg.length;
  };
`;

// What kind of box element `id` is: { kind: 'native', options, current } for a <select>, { kind: 'custom', editable, expanded, current } for a
// combobox or listbox button, { kind: 'other' } for anything else, null when it is gone.
function selectInfo(id) {
  return `(() => {
    ${HELPERS}
    ${SELECT_HELPERS}
    const entry = entryFor(${Number(id)});
    if (!entry) return null;
    const el = entry.el;
    if (el.tagName === 'SELECT') return { kind: 'native', multiple: el.multiple, options: [...el.options].map((o) => norm(o.text)), current: displayOf(el) };
    if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type)) return { kind: 'other' };
    // A search box with suggestions (a site's search, an address finder) is typed into: picking a suggestion there would run the search.
    if (el.tagName === 'INPUT' && (el.type === 'search' || el.closest('[role=search]') || /^(q|query|search|search_query)$/i.test(el.name || ''))) return { kind: 'other' };
    const box = boxOf(el);
    if (!box) return { kind: 'other' };
    const input = textInput(el) ? el : [...box.querySelectorAll('input,textarea,[contenteditable=""],[contenteditable=true]')].find((n) => textInput(n) && shown(n));
    return { kind: 'custom', editable: Boolean(input), freeText: el.tagName === 'INPUT' && textInput(el), expanded: expandedOf(box) && Boolean(listOf(box)), current: displayOf(el) };
  })()`;
}

// Sets a native <select> to the option `text` names (React and friends see it: the native setter, then input and change).
// { shown } on success, { error: 'no-option', options } when no option matches.
function chooseNative(id, text) {
  return `(() => {
    ${HELPERS}
    ${SELECT_HELPERS}
    const el = entryFor(${Number(id)})?.el;
    if (!el || el.tagName !== 'SELECT') return null;
    const opts = [...el.options];
    const k = matchOption(opts.map((o) => ({ text: o.text, value: o.value })), ${JSON.stringify(String(text))});
    if (k < 0 || opts[k].disabled) return { error: k < 0 ? 'no-option' : 'disabled', options: opts.filter((o) => !o.disabled).map((o) => norm(o.text)) };
    bringIntoView(el, false);
    if (el.multiple) opts.forEach((o, i) => { o.selected = i === k; });
    else Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opts[k].value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return opts[k].selected ? { shown: norm(opts[k].text) } : null;
  })()`;
}

// The options of a native <select> (an error names them).
function nativeOptions(id) {
  return `(() => { ${HELPERS} const el = entryFor(${Number(id)})?.el; return el && el.tagName === 'SELECT' ? [...el.options].filter((o) => !o.disabled).map((o) => o.text.replace(/\\s+/g, ' ').trim()) : null; })()`;
}

// One look at the list box `id` opened (id null: the open list on the page, if any). step 'top' scrolls the list to its start first, 'next'
// one list-height further. Returns { list, options (the texts rendered now), match: { id, text } (registered, to click) | null, atEnd,
// loading, whole (no scrolling: every option is in view) } or null when the element is gone.
function scanList(id, want, step = '', exactOnly = false) {
  return `(async () => {
    ${HELPERS}
    ${SELECT_HELPERS}
    let box = null, chain = [];
    if (${id == null ? 'false' : 'true'}) {
      const entry = entryFor(${Number(id)});
      if (!entry) return null;
      box = boxOf(entry.el) || entry.el;
      chain = entry.chain;
    }
    const list = listOf(box);
    if (!list) return { list: false, options: [], match: null, atEnd: true, loading: false };
    const scroller = scrollerOf(list);
    const step = ${JSON.stringify(step)};
    if (scroller && step) {
      const before = scroller.scrollTop;
      if (step === 'top') scroller.scrollTop = 0;
      else scroller.scrollTop = before + Math.max(20, scroller.clientHeight - 24);
      if (scroller.scrollTop !== before) scroller.dispatchEvent(new Event('scroll')); // (a tab that paints no frames fires its own scroll events late)
      if (scroller.scrollTop !== before) await new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 120); }); // a virtualized list renders the new rows
    }
    const opts = optionsIn(list);
    const texts = opts.map((o) => norm(o.innerText || o.textContent));
    const loading = list.getAttribute('aria-busy') === 'true' || (!opts.length && /loading|searching|please wait/i.test(list.innerText || ''))
      || Boolean(list.ownerDocument.querySelector('[role=progressbar]:not([hidden]), .select2-results__option.loading-results'));
    const atEnd = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    const want = ${JSON.stringify(want == null ? '' : String(want))};
    const k = want ? matchOption(texts.map((t, i) => ({ text: t, value: opts[i].getAttribute('data-value') })), want, ${exactOnly ? 'true' : 'false'}) : -1;
    let match = null;
    if (k >= 0 && opts[k].getAttribute('aria-disabled') !== 'true') {
      let opt = opts[k];
      const r = opt.getBoundingClientRect(), s = scroller ? scroller.getBoundingClientRect() : null;
      if (s && (r.top < s.top || r.bottom > s.bottom)) {
        opt.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        scroller.dispatchEvent(new Event('scroll'));
        await new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 120); });
        if (!opt.isConnected) opt = optionsIn(list).find((o) => norm(o.innerText || o.textContent) === texts[k]) || opt; // a virtualized list drew the row again
      }
      match = { id: register(opt, chain, texts[k]), text: texts[k] };
    }
    return { list: true, options: texts.filter(Boolean), match, atEnd, loading, whole: !scroller };
  })()`;
}

// The text field to type into to filter box `id`: the field itself, one inside it, or the search field its popup moved the focus to.
// Its registered id, or null.
function searchField(id) {
  return `(() => {
    ${HELPERS}
    ${SELECT_HELPERS}
    const entry = entryFor(${Number(id)});
    if (!entry) return null;
    const box = boxOf(entry.el) || entry.el;
    let field = textInput(entry.el) ? entry.el : [...box.querySelectorAll('input,textarea')].find((n) => textInput(n) && shown(n));
    if (!field) {
      let a = box.ownerDocument.activeElement;
      while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
      if (textInput(a) && shown(a)) field = a;
    }
    const list = !field && listOf(box);
    if (list && list.parentElement && !/^(BODY|HTML)$/.test(list.parentElement.tagName)) { const near = list.parentElement.querySelector('input[type=search], input.select2-search__field, input[type=text]'); if (near && shown(near)) field = near; }
    return field ? register(field, entry.chain, 'search') : null;
  })()`;
}

// Does field `id` show `text` now? { shows, current }.
function fieldShows(id, text) {
  return `(() => {
    ${HELPERS}
    ${SELECT_HELPERS}
    const entry = entryFor(${Number(id)});
    if (!entry) return null;
    const current = displayOf(entry.el);
    const want = norm(${JSON.stringify(String(text))}).toLowerCase();
    return { shows: current.toLowerCase().includes(want), current: current.slice(0, 200) };
  })()`;
}

// A native <option> whose text matches, in any shown <select> on the page: its select's registered id and the option's text, or null.
// An exact match wins over a looser one in another select.
function findNativeOption(text) {
  return `(() => {
    ${HELPERS}
    ${SELECT_HELPERS}
    const want = ${JSON.stringify(String(text))};
    let best = null;
    for (const entry of window.__claudeEls || []) {
      if (!entry || !entry.el.isConnected || entry.el.tagName !== 'SELECT') continue;
      const opts = [...entry.el.options];
      const k = matchOption(opts.map((o) => ({ text: o.text, value: o.value })), want);
      if (k < 0 || opts[k].disabled) continue;
      const exact = norm(opts[k].text).toLowerCase() === norm(want).toLowerCase();
      if (!best || (exact && !best.exact)) best = { el: entry.el, chain: entry.chain, text: norm(opts[k].text), exact };
    }
    return best ? { id: register(best.el, best.chain, best.text), text: best.text } : null;
  })()`;
}

// The open dropdown's box on the page (a combobox marked expanded): its registered id, or null.
const OPEN_BOX = `(() => {
  ${HELPERS}
  ${SELECT_HELPERS}
  const boxes = [...document.querySelectorAll('[role=combobox][aria-expanded=true], [aria-haspopup][aria-expanded=true]')].filter(shown);
  const box = boxes[boxes.length - 1];
  return box && listOf(box) ? register(box, [], norm(box.getAttribute('aria-label') || box.innerText).slice(0, 60)) : null;
})()`;

// The scroll tool on a page with a dropdown list open: that list scrolls (it is what the AI is looking through), not the page.
// { scrolled: 'list', y, max, options } or null when no list is open.
function scrollOpenList(pages) {
  return `(async () => {
    ${HELPERS}
    ${SELECT_HELPERS}
    const boxes = [...document.querySelectorAll('[role=combobox][aria-expanded=true], [aria-haspopup][aria-expanded=true]')].filter(shown);
    const box = boxes[boxes.length - 1];
    const list = box && listOf(box);
    const scroller = list && !list.matches('[role=menu],[role=tree]') && scrollerOf(list); // (a site's open menu is not a dropdown: the page scrolls)
    if (!scroller) return null;
    scroller.scrollTop += Math.round(scroller.clientHeight * 0.85 * ${Number(pages) || 1});
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 120); });
    const opts = optionsIn(list).map((o) => norm(o.innerText || o.textContent)).filter(Boolean);
    return { scrolled: 'list', y: Math.round(scroller.scrollTop), max: Math.round(scroller.scrollHeight - scroller.clientHeight), options: opts.slice(0, 40) };
  })()`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A local id (in the frame the box is in) back to the id the tools take.
const fullId = (boxId, local) => { const at = frames.decodeId(boxId); return at ? frames.encodeId(at.n, local) : local; };

// Looks through the open list of box `id` for `want`: what is rendered, then (scroll: true) from the top down, a list-height at a time.
// Waits for options that are still loading (up to waitMs). { match, seen: [texts], list }.
async function search(agent, wc, id, want, { scroll = true, waitMs = 3000 } = {}) {
  const seen = [];
  const run = (step, target = want, exactOnly = false) => agent.elementRun(wc, id ?? 0, (k) => scanList(id == null ? null : k, target, step, exactOnly));
  const end = Date.now() + waitMs;
  let r = await run('');
  while (r && (!r.list || (r.loading && !r.match) || (!r.options.length && !r.match)) && Date.now() < end) { // opening, or options loading
    agent.stopCheck?.();
    await sleep(150);
    r = await run('');
  }
  if (!r) return { match: null, seen, list: false };
  seen.push(...r.options);
  if (!r.list) return { match: null, seen, list: false };
  const exact = r.match && matchOption([{ text: r.match.text }], want, true) === 0;
  if (exact || (r.match && r.whole)) return { match: r.match, seen, list: true }; // exact, or the whole list was in view
  if (!scroll) return { match: null, seen, list: true };
  // A list longer than its box (a virtualized one renders only the rows in view): from the top, a list-height at a time, an exact match only;
  // then the best looser match among all the rows seen, scrolled to again.
  const walk = async (target, exactOnly) => {
    let s = await run('top', target, exactOnly);
    for (let i = 0; s && i < 400; i++) {
      seen.push(...s.options);
      if (s.match || s.atEnd) break;
      agent.stopCheck?.();
      s = await run('next', target, exactOnly);
    }
    return s?.match || null;
  };
  let match = await walk(want, true);
  if (!match) {
    const texts = [...new Set(seen)];
    const k = matchOption(texts.map((text) => ({ text })), want);
    if (k >= 0) match = await walk(texts[k], true);
  }
  return { match, seen, list: true };
}

// Opens box `id` (unless it is open), finds the option `want` in its list (typing into it when it filters), clicks it and confirms the field shows
// it. `label` names the field in messages. Returns the result line; throws with the options when `want` is not there.
async function chooseCustom(agent, wc, id, want, info, label) {
  if (!info.expanded) await agent.execute('click', { element_id: id });
  // (a box you type into may show no list until it is typed in: a short wait, then the typing)
  let found = await search(agent, wc, id, want, { scroll: false, waitMs: info.editable ? 700 : 2500 });
  if (!found.list && !info.expanded && !info.editable) { // a box that opens on a second click (some open on mousedown only once focused)
    await agent.execute('click', { element_id: id });
    found = await search(agent, wc, id, want, { scroll: false, waitMs: 1500 });
  }
  const seen = [...found.seen];
  let typed = false;
  if (!found.match) {
    const field = await agent.elementRun(wc, id, searchField);
    if (field) { // filters as you type (or loads matches from a server): the option's text narrows the list
      await agent.execute('type_text', { element_id: fullId(id, field), text: want });
      typed = true;
      found = await search(agent, wc, id, want, { scroll: true, waitMs: 3000 });
      seen.push(...found.seen);
    }
  }
  if (!found.match && found.list && !typed) {
    found = await search(agent, wc, id, want, { scroll: true, waitMs: 1500 });
    seen.push(...found.seen);
  }
  if (!found.match) {
    if (!found.list && !typed) throw new Error(`${label} did not open a list of options after a click. Take a screenshot to see it, or read_page mode:"compact" for its options.`);
    await agent.execute('press_key', { key: 'Escape' }).catch(() => {});
    if (typed && info.freeText) { // a field that takes any text (its list only suggests): what was typed stays, and is the answer
      const kept = await agent.elementRun(wc, id, (k) => fieldShows(k, want));
      if (kept && kept.shows) return `typed "${want}" (no suggestion in its list matched${seen.length ? `; it suggested ${optionList(seen, 10)}` : ''})`;
    }
    throw new Error(`${label} has no option matching "${want}". ${typed ? 'Options it showed' : 'Its options'}: ${optionList(seen)}.`);
  }
  try { await agent.execute('click', { element_id: fullId(id, found.match.id) }); } catch (err) {
    if (!/No element with id/.test(err.message)) throw err;
    found = await search(agent, wc, id, found.match.text, { scroll: true, waitMs: 1000 }); // the list drew its rows again: once more
    if (!found.match) throw err;
    await agent.execute('click', { element_id: fullId(id, found.match.id) });
  }
  let check = await agent.elementRun(wc, id, (k) => fieldShows(k, found.match.text));
  for (let i = 0; check && !check.shows && i < 6; i++) { await sleep(150); check = await agent.elementRun(wc, id, (k) => fieldShows(k, found.match.text)); }
  if (check && !check.shows) throw new Error(`Clicked the option "${found.match.text}" in ${label}, but the field does not show it (it shows "${check.current || 'nothing'}"). Take a screenshot to check.`);
  return `chose "${found.match.text}"`;
}

// fill_form's dropdown step for field `id`: null when the field is not a dropdown (the caller types into it), else the result line.
async function choose(agent, wc, id, want, label) {
  const info = await agent.elementRun(wc, id, selectInfo);
  if (!info || info.kind === 'other') return null;
  agent.pointAt?.(wc, id, 'click'); // [agent cursors]
  if (info.kind === 'native') {
    const set = await agent.elementRun(wc, id, (k) => chooseNative(k, want));
    if (set && set.shown !== undefined) return `chose "${set.shown}"`;
    if (set && set.error) throw new Error(`${label} has no ${set.error === 'disabled' ? 'enabled ' : ''}option matching "${want}". Its options: ${optionList(set.options)}.`);
    throw new Error(`Could not set ${label} to "${want}".`);
  }
  return chooseCustom(agent, wc, id, want, info, label);
}

// click by visible text that names no element: a native <option> (its select is set), or an option of the dropdown list that is open
// (scrolled to and clicked). The result line, or null when neither has it.
async function clickOption(agent, wc, text, runScript) {
  const native = await runScript(wc, findNativeOption(text)).catch(() => null);
  if (native) {
    agent.pointAt?.(wc, native.id, 'click'); // [agent cursors]
    const set = await runScript(wc, chooseNative(native.id, native.text));
    if (set && set.shown !== undefined) return `Chose "${set.shown}" in dropdown ${native.id} (a <select>: its option is set directly).`;
  }
  const box = await runScript(wc, OPEN_BOX).catch(() => null);
  if (!box) return null;
  const found = await search(agent, wc, box, text, { scroll: true, waitMs: 1000 });
  if (!found.match) return null;
  await agent.execute('click', { element_id: found.match.id });
  return `Clicked the option "${found.match.text}" in the open list.`;
}

// click on a native <select>: its popup is drawn by the system, where the AI can neither see nor click it, so it is not opened.
async function nativeClickNote(agent, wc, id) {
  const info = await agent.elementRun(wc, id, selectInfo);
  if (!info || info.kind !== 'native') return null;
  return `Element ${id} is a dropdown (<select>) showing "${String(info.current).split(' | ')[0]}"; it was not opened (its list is a system popup). Its options: ${optionList(info.options)}. To choose one, click the option's text, or fill_form with this field's label and the option.`;
}

module.exports = { matchOption, optionList, selectInfo, chooseNative, nativeOptions, scanList, searchField, fieldShows, findNativeOption, OPEN_BOX, scrollOpenList, choose, clickOption, nativeClickNote };
