// A tab the AI names in the chat, as a chip: its icon and current title (cut with an ellipsis; the full title and address in the tooltip).
// Clicking it switches to that tab, in whichever window it is; a closed tab is offered again when its address is known.
// Where chips come from, and only from here:
//   - decorate(root, tabs): the [[tab:ID]] markers in the text of one of the AI's own reply bubbles (never code, a link, your own message)
//   - forStep(row, name, input, tabs): the tabs a step names in its own input (structured data, never page text)
//   - chip(...): the Browser card's tab
// Titles come from the browser, never from the marker. Main pushes a change (chips:update) from the events that already report tab changes,
// so nothing here polls. A saved chat gives each tab it names as { t: title, u: address, s: the run of the app whose ids they are }.
(() => {
  const tr = (k, v) => window.t(k, v);
  const api = () => window.assistant?.tabChips;
  const info = new Map(); // key -> what main last said { state, title, url, favicon, reopen }
  const chips = new Map(); // key -> Set of chip elements on screen
  const snaps = new Map(); // key -> { t, u }: what a saved chat kept
  const keyOf = (id, s) => (s ? `${id}@${s}` : String(id));
  const host = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };
  const GLOBE = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.5 2.4 3.3 2.4 5.5S9.600 12 8 13.500C6.400 12 5.600 10.200 5.600 8S6.400 4 8 2.500Z"/></svg>';

  function view(el) { // what the chip shows now
    const key = el.dataset.key;
    const snap = (key && snaps.get(key)) || el._snap || null;
    const seen = key ? info.get(key) : null;
    const live = seen && (seen.state !== 'gone' || !snap) ? seen : null; // (a saved chat's own snapshot beats "never seen")
    const state = live ? live.state : snap ? 'closed' : key ? 'pending' : 'closed';
    const title = (live && live.title) || snap?.t || '';
    const url = (live && live.url) || snap?.u || '';
    const reopen = live ? live.reopen : /^https?:\/\//i.test(snap?.u || '');
    return { state, title, url, reopen, favicon: live?.favicon || snap?.f || null };
  }
  function paint(el) {
    const v = view(el);
    const name = v.title || host(v.url) || tr(v.state === 'gone' ? 'tabref.unknown' : 'tabref.untitled');
    const closed = v.state === 'closed' || v.state === 'gone';
    el.classList.toggle('closed', closed);
    el.dataset.state = v.state;
    const label = el.querySelector('.tab-ref-title');
    if (label.textContent !== name) label.textContent = name;
    const canOpen = !closed || v.reopen;
    el.setAttribute('aria-disabled', canOpen ? 'false' : 'true');
    el.setAttribute('aria-label', tr(!closed ? 'tabref.switch' : v.reopen ? 'tabref.reopen' : 'tabref.closed', { title: name }));
    const tip = [name, v.url].filter(Boolean);
    if (closed) tip.push(tr(v.reopen ? 'tabref.closed.reopen' : 'tabref.closed.gone'));
    el.title = tip.join('\n');
    const icon = el.querySelector('.tab-ref-icon');
    const src = v.favicon || ''; // (a closed tab keeps its icon, drawn dimmed)
    if (icon.dataset.src !== src) {
      icon.dataset.src = src;
      icon.textContent = '';
      if (src) { const img = Object.assign(document.createElement('img'), { alt: '', decoding: 'async', src }); img.onerror = () => { icon.dataset.src = ''; icon.textContent = ''; icon.insertAdjacentHTML('beforeend', GLOBE); }; icon.append(img); } else icon.insertAdjacentHTML('beforeend', GLOBE);
    }
  }

  let timer = 0;
  let last = '';
  function sync() { // tell main which tabs are on screen (batched); it answers with their state
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const keys = [];
      for (const [key, set] of chips) {
        for (const el of set) if (!el.isConnected) set.delete(el);
        if (set.size) keys.push(key); else chips.delete(key);
      }
      const joined = keys.join(',');
      if (joined === last && keys.every((k) => info.has(k))) return;
      last = joined;
      const a = api();
      if (!a) return;
      try { apply(await a.watch(keys.slice(0, 200))); } catch { /* the chip keeps what it had */ }
    }, 40);
  }
  function apply(update) {
    if (!update || typeof update !== 'object') return;
    for (const [key, v] of Object.entries(update)) {
      info.set(key, v);
      for (const el of chips.get(key) || []) if (el.isConnected) paint(el);
    }
  }
  try { api()?.onUpdate?.(apply); } catch { /* an old preload */ }

  function click(el) {
    const v = view(el);
    if (el.getAttribute('aria-disabled') === 'true') return;
    const key = el.dataset.key || '';
    Promise.resolve(api()?.open?.({ key, url: v.url })).then((r) => { if (r?.reopened || r?.ok === false) sync(); }).catch(() => {});
  }

  // One chip. `ref`: { id, s } or null (a card's tab that has no id), `snap`: { t, u } kept by a saved chat.
  function chip(ref, snap = null) {
    const key = ref && Number.isInteger(ref.id) ? keyOf(ref.id, ref.s || '') : '';
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tab-ref';
    if (key) el.dataset.key = key;
    el.innerHTML = '<span class="tab-ref-icon" aria-hidden="true"></span><span class="tab-ref-title"></span>';
    if (snap && (snap.t || snap.u)) { el._snap = { t: String(snap.t || ''), u: String(snap.u || ''), f: String(snap.f || '') }; if (key) snaps.set(key, el._snap); }
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); click(el); });
    paint(el);
    if (key) { let set = chips.get(key); if (!set) chips.set(key, (set = new Set())); set.add(el); sync(); }
    return el;
  }

  // [[tab:12]] in the text nodes of one of the AI's reply bubbles. `tabs`: { id: { t, u, s } } from a saved chat.
  function decorate(root, tabs = null) {
    if (!root || !window.tabMarker) return;
    const text = root.source !== undefined ? root.source : root.textContent; // (a streaming bubble keeps its source: no walk of the page for every frame)
    if (!text || !text.includes('[[tab:')) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.includes('[[tab:') && !n.parentElement.closest('code, pre, a, button, .math-src, math, .tab-ref') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const parts = node.nodeValue.split(/(\[\[tab:\d{1,9}\]\])/);
      if (parts.length < 2) continue;
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        const m = /^\[\[tab:(\d{1,9})\]\]$/.exec(part);
        if (!m) { if (part) frag.append(part); continue; }
        const id = Number(m[1]);
        const kept = tabs && (tabs[id] || tabs[String(id)]);
        frag.append(chip({ id, s: kept?.s || '' }, kept || null));
      }
      node.replaceWith(frag);
    }
  }

  // The tabs a step's input names (switch_tab, close_tab, read_tabs, group_tabs, any tab_id), after its label.
  const FIRST = { switch_tab: 'tabref.step.switch', close_tab: 'tabref.step.close' };
  function forStep(row, name, input, tabs, extra = null) {
    if (!row || !window.tabMarker) return;
    for (const old of row.querySelectorAll(':scope > .tab-ref, :scope > .tab-ref-more')) old.remove();
    const ids = window.tabMarker.stepTabs(name, input);
    if (extra != null && Number.isInteger(extra) && !ids.includes(extra)) ids.push(extra);
    if (!ids.length) return;
    const bare = String(name || '').replace(/^mcp__lumen__/, '');
    const detail = row.firstChild;
    if (FIRST[bare] && detail) { detail.textContent = tr(FIRST[bare]); row.title = tr(FIRST[bare]); }
    let at = detail;
    for (const id of ids.slice(0, 3)) {
      const kept = tabs && (tabs[id] || tabs[String(id)]);
      const c = chip({ id, s: kept?.s || '' }, kept || null);
      at.after(c);
      at = c;
    }
    if (ids.length > 3) at.after(Object.assign(document.createElement('span'), { className: 'tab-ref-more', textContent: tr('tabref.more', { count: ids.length - 3 }) }));
  }

  window.tabRef = { chip, decorate, forStep };
})();
