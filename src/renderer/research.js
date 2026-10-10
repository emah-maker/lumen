// The sidebar's Research board: the open chat's sources (the AI's and yours) with quality chips, notes, pinned quotes and
// citation copy; "Add this page" for the tab in front. Also turns a ```sources block in an AI answer (/research ends with one)
// into a list with the same chips. The data lives in main (ai/research-board.js, saved with the chat); this file only draws it
// and sends the user's clicks back (window.assistant.research). Everything is built with textContent, never innerHTML from data.
// Loaded after tasks.js (same page).

(() => {
  const api = window.assistant?.research;
  if (!api) return;
  const T = (key, vars) => window.t(key, vars);
  const byId = (id) => document.getElementById(id);
  const button = byId('research-btn');
  const badge = byId('research-badge');
  const panel = byId('research-panel');
  const live = byId('task-live');
  if (!button || !panel) return;

  let state = { sources: [], count: 0, styles: [] };
  let style = 'apa';
  try { style = localStorage.getItem('lumen.research.style') || 'apa'; } catch { /* storage can be blocked */ }
  const expanded = new Set();
  let busy = '';

  const h = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return node;
  };
  const icon = (svg, label, onclick, cls = 'icon-btn') => { const b = h('button', { type: 'button', className: cls, title: label, onclick }); b.setAttribute('aria-label', label); b.innerHTML = svg; return b; };
  const STAR = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m8 2 1.8 3.8 4.1.5-3 2.9.8 4.1L8 11.2l-3.7 2.1.8-4.1-3-2.9 4.1-.5z"/></svg>';
  const CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  const say = (text) => { if (live) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); } };

  // A chip: the translated text where the panel knows the id, else the English the main process wrote.
  const chipText = (c) => {
    const key = `research.chip.${c.id}`;
    const text = T(key, { n: c.n ?? '' });
    return text === key ? c.text : text;
  };
  const chipTip = (c) => {
    if (!c.tipId) return chipText(c);
    const key = `research.chip.${c.tipId}`;
    const text = T(key, { n: c.n ?? '' });
    return text === key ? c.tip || chipText(c) : text;
  };
  const chips = (list) => h('div', { className: 'rs-chips' }, ...(list || []).map((c) => h('span', { className: `rs-chip ${c.tone || 'info'}`, textContent: chipText(c), title: chipTip(c) })));
  const names = (authors) => {
    const list = (authors || []).map((a) => a.literal || [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean);
    return list.length > 3 ? `${list.slice(0, 3).join(', ')} ${T('research.etal')}` : list.join(', ');
  };

  async function copy(n) {
    const r = await api.cite(n, style);
    say(r?.ok ? T('research.copied', { style: (state.styles.find((s) => s.id === style) || {}).name || style }) : T('research.copyFailed'));
    return r;
  }

  function quoteRow(s, q) {
    const where = [q.page ? T('research.page', { n: q.page }) : '', q.heading].filter(Boolean).join(' · ');
    const verify = q.verified === true ? 'good' : q.verified === false ? 'bad' : 'warn';
    const verifyText = T(q.verified === true ? 'research.chip.verified' : q.verified === false ? 'research.chip.notfound' : 'research.chip.unverified');
    return h('li', { className: 'rs-quote' },
      h('blockquote', { textContent: q.text }),
      h('div', { className: 'rs-quote-meta' },
        h('span', { className: `rs-chip ${verify}`, textContent: verifyText }),
        where ? h('span', { textContent: where }) : null,
        q.link ? h('button', { type: 'button', className: 'rs-link', textContent: T('research.openPassage'), onclick: () => api.open(q.link) }) : null,
        icon(CLOSE, T('research.unpin'), () => api.unpin(s.n, q.q), 'icon-btn rs-x')));
  }

  function card(s) {
    const open = expanded.has(s.n);
    const star = icon(STAR, T(s.starred ? 'research.unstar' : 'research.star'), () => api.update(s.n, { starred: !s.starred }), `icon-btn rs-star${s.starred ? ' on' : ''}`);
    star.setAttribute('aria-pressed', String(s.starred));
    const title = h('button', { type: 'button', className: 'rs-title', textContent: s.title, title: T('research.open'), onclick: () => s.url && api.open(s.url) });
    const toggle = h('button', { type: 'button', className: 'rs-toggle', textContent: open ? '▾' : '▸', onclick: () => { if (open) expanded.delete(s.n); else expanded.add(s.n); render(); } });
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', T('research.details', { n: s.n }));
    const meta = [names(s.authors), s.year, s.venue].filter(Boolean).join(' · ');
    const li = h('li', { className: `rs-card${s.retracted ? ' retracted' : ''}`, id: `rs-${s.n}` },
      h('div', { className: 'rs-top' }, star, h('span', { className: 'rs-n', textContent: `[${s.n}]` }), title, toggle),
      meta ? h('div', { className: 'rs-meta', textContent: meta }) : null,
      chips(s.chips));
    if (!open) return li;
    const note = h('textarea', { className: 'rs-note', rows: 2, value: s.note || '', placeholder: T('research.notePlaceholder') });
    note.setAttribute('aria-label', T('research.note'));
    note.onchange = () => api.update(s.n, { note: note.value });
    const pinBox = h('input', { type: 'text', className: 'rs-pin-text', placeholder: T('research.pinPlaceholder') });
    const pinPage = h('input', { type: 'number', min: '1', className: 'rs-pin-page', placeholder: T('research.pinPage') });
    pinPage.setAttribute('aria-label', T('research.pinPage'));
    li.append(
      s.abstract ? h('p', { className: 'rs-abstract', textContent: s.abstract }) : null,
      h('p', { className: 'rs-ref', textContent: s.reference }),
      h('p', { className: 'rs-by', textContent: T(s.by === 'user' ? 'research.byYou' : 'research.byAi') + (s.doi ? ` · doi:${s.doi}` : '') }),
      note,
      s.quotes.length ? h('ul', { className: 'rs-quotes' }, ...s.quotes.map((q) => quoteRow(s, q))) : null,
      h('div', { className: 'rs-pin' }, pinBox, pinPage,
        h('button', { type: 'button', className: 'btn', textContent: T('research.pin'), onclick: async () => { if (!pinBox.value.trim()) return; const r = await api.pin(s.n, pinBox.value, pinPage.value); if (!r?.ok) say(r?.message || T('research.pinFailed')); } }),
        h('button', { type: 'button', className: 'btn', textContent: T('research.pinSelection'), onclick: async () => { const r = await api.pinSelection(s.n); if (r && !r.ok) say(T(r.reason === 'no-selection' ? 'research.noSelection' : 'research.pinFailed')); } })),
      h('div', { className: 'rs-actions' },
        h('button', { type: 'button', className: 'btn', textContent: T('research.copyCite'), onclick: () => copy(s.n) }),
        s.pdfUrl || s.oaUrl ? h('button', { type: 'button', className: 'btn', textContent: T(s.pdfUrl ? 'research.openPdf' : 'research.openFree'), onclick: () => api.open(s.pdfUrl || s.oaUrl) }) : null,
        h('button', { type: 'button', className: 'btn danger', textContent: T('research.remove'), onclick: () => { expanded.delete(s.n); api.remove(s.n); } })));
    return li;
  }

  const FAIL = { 'no-tab': 'research.addFail.noTab', 'not-web': 'research.addFail.notWeb', unreadable: 'research.addFail.unreadable' };
  async function addPage() {
    busy = 'add';
    render();
    const r = await api.addPage().catch(() => ({ ok: false, reason: 'unreadable' }));
    busy = '';
    if (r?.ok) { expanded.add(r.n); say(T(r.added ? 'research.added' : 'research.alreadyAdded')); }
    else say(T(FAIL[r?.reason] || 'research.addFail.unreadable'));
    await refresh();
  }

  function render() {
    const close = icon(CLOSE, T('research.close'), () => closePanel(true), 'icon-btn research-close');
    const head = h('div', { className: 'chat-list-head' }, h('h2', { textContent: `${T('research.title')} · ${T('research.count', { n: state.count })}` }), close);
    const select = h('select', { className: 'rs-style' }, ...(state.styles || []).map((s) => h('option', { value: s.id, textContent: s.name, selected: s.id === style })));
    select.setAttribute('aria-label', T('research.style'));
    select.title = T('research.style'); // no visible label: hovering says what the menu is
    select.onchange = () => { style = select.value; try { localStorage.setItem('lumen.research.style', style); } catch { /* fine */ } };
    const bar = h('div', { className: 'rs-bar' },
      h('button', { type: 'button', className: 'btn rs-add', textContent: T('research.addPage'), disabled: busy === 'add', onclick: addPage }),
      select,
      h('button', { type: 'button', className: 'btn', textContent: T('research.copyBib'), disabled: !state.count, onclick: () => copy(null) }));
    const body = state.sources.length
      ? h('ul', { className: 'chat-items rs-list' }, ...state.sources.map(card))
      : h('p', { className: 'chat-list-empty', textContent: T('research.empty') });
    const keep = panel.querySelector('.rs-list')?.scrollTop || 0;
    const focused = document.activeElement && panel.contains(document.activeElement) && document.activeElement.id ? document.activeElement.id : '';
    panel.replaceChildren(head, bar, body);
    const list = panel.querySelector('.rs-list');
    if (list) list.scrollTop = keep;
    if (focused) byId(focused)?.focus();
  }

  // Someone is typing a note or a quote in the panel: a redraw (the AI just added a source) waits until they leave the field.
  let pending = false;
  const typing = () => /^(TEXTAREA|INPUT)$/.test(document.activeElement?.tagName || '') && panel.contains(document.activeElement);
  panel.addEventListener('focusout', () => setTimeout(() => { if (pending && !typing()) { pending = false; refresh(); } }, 50));
  async function refresh() {
    try { state = await api.get(); } catch { return; }
    const n = state.count || 0;
    badge.textContent = String(n);
    badge.hidden = n === 0;
    button.title = n ? `${T('research.button')} (${n})` : T('research.button');
    if (!panel.hidden) { if (typing()) pending = true; else render(); }
    refreshLists();
  }

  function showSidebar() { if (document.body.classList.contains('sidebar-hidden')) (window.showSidebarFor || (() => byId('toggle-sidebar').click()))(); }
  async function openPanel() {
    showSidebar();
    await refresh();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('active');
    render();
    panel.querySelector('.rs-add')?.focus();
  }
  function closePanel(refocus) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.classList.remove('active');
    if (refocus) (button.offsetParent ? button : byId('more-actions') || button).focus(); // the button sits in the closed More menu
  }
  button.onclick = () => (panel.hidden ? openPanel() : closePanel(true));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closePanel(true); } });
  api.onChanged(() => refresh());
  window.assistant?.chats?.onChanged?.(() => refresh()); // a chat was opened or started: its own board

  // ---- the Sources list in an answer: ```sources / lines "[n] ..." -> the board's entries with their chips
  const lists = new Set();
  function drawList(box) {
    const ns = [...String(box.dataset.sourceText || '').matchAll(/^\s*\[(\d{1,3})\]/gm)].map((m) => Number(m[1]));
    const rows = ns.map((n) => {
      const s = state.sources.find((x) => x.n === n);
      if (!s) return h('li', { className: 'rs-src missing' }, h('span', { className: 'rs-n', textContent: `[${n}]` }), h('span', { textContent: T('research.notOnBoard') }));
      return h('li', { className: `rs-src${s.retracted ? ' retracted' : ''}` },
        h('span', { className: 'rs-n', textContent: `[${n}]` }),
        h('div', { className: 'rs-src-body' },
          s.url ? h('button', { type: 'button', className: 'rs-title', textContent: s.title, onclick: () => api.open(s.url) }) : h('span', { className: 'rs-title', textContent: s.title }),
          h('div', { className: 'rs-meta', textContent: [names(s.authors), s.year, s.venue].filter(Boolean).join(' · ') }),
          chips(s.chips)));
    });
    box.replaceChildren(...rows);
  }
  function refreshLists() { for (const box of [...lists]) { if (!box.isConnected) lists.delete(box); else drawList(box); } }
  function decorate(root) {
    if (!root?.querySelectorAll) return;
    for (const pre of root.querySelectorAll('pre[data-lang="sources"]')) {
      if (pre.dataset.sourcesDone) continue;
      pre.dataset.sourcesDone = '1';
      const box = h('ol', { className: 'rs-sources' });
      box.dataset.sourceText = pre.textContent || '';
      if (!/^\s*\[\d{1,3}\]/m.test(box.dataset.sourceText)) continue; // not our format: leave the code block
      pre.replaceWith(box);
      lists.add(box);
      drawList(box);
    }
  }
  window.researchUi = { decorate, refresh };
  refresh();
})();
