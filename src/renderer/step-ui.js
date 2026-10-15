// How the AI's steps look in the chat, in the sidebar and the full-page chat alike (loaded after step-labels.js, before chat-core.js):
//   - one readable line per step; click or Enter opens the exact command / input and the output (copyable), collapsed by default
//   - consecutive steps of one kind and target are one row with a count ("Read 4 pages"), expanding to its members
//   - a step on a surface (the browser; the shell and files) sits in an activity card: icon tile, "Browser", "Working · Find lab TA",
//     a live thumbnail of the tab, "Open preview", and its steps folded under "N steps". A line of the assistant's narration ends the card.
//   - a running step has a spinner and a ticking timer (chat-core showStepTime); a failed one reads plainly with a short red reason
// Stream updates touch only a row's text, the card's subtitle / step summary and the thumbnail's src.
(() => {
  const tr = (k, v) => window.t(k, v);
  let labeller = null;
  const SL = () => (labeller ||= window.stepLabels.create(window.t));
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const MORE_MAX = 4000;
  const ICONS = {
    browser: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5S9.400 5.900 12 3.500Z"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="m7.500 9.500 3 2.500-3 2.500M12.500 15h4"/></svg>',
    files: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.500h6.500L18 8v11.500a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z"/><path d="M13.500 3.500V8H18M9 12.500h6M9 16h6"/></svg>',
  };

  // ---- rows
  function makeRow(label, running, data) {
    const row = el('div', { className: running ? 'step running' : 'step done' });
    row.innerHTML = '<span class="step-detail"></span>';
    row.firstChild.textContent = label;
    row.title = label;
    if (running) { row.dataset.t0 = String(Date.now()); row.append(el('span', { className: 'step-time' })); }
    row._s = data;
    if (data && (data.input || running)) { row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-expanded', 'false'); row.dataset.more = '1'; }
    return row;
  }
  function setLabel(row, label) { row.firstChild.textContent = label; row.title = label; if (row._s) row._s.label = label; }

  const clipText = (s) => { const v = String(s ?? ''); return v.length > MORE_MAX ? `${v.slice(0, MORE_MAX)}\n${tr('step.details.cut')}` : v; };
  const inputText = (s) => {
    const i = s?.input;
    if (!i || typeof i !== 'object') return { head: '', text: '' };
    const hide = (v) => window.stepLabels.redact(v); // tokens, keys and passwords in arguments are masked before they are shown
    if (typeof i.command === 'string') return { head: tr('step.details.command'), text: hide(i.command) };
    try { return { head: tr('step.details.input'), text: hide(JSON.stringify(i, null, 2)) }; } catch { return { head: '', text: '' }; }
  };
  function section(head, text, mono = true) {
    const box = el('div', { className: 'step-sec' });
    const copy = el('button', { type: 'button', className: 'step-copy', textContent: tr('step.details.copy') });
    copy.setAttribute('aria-label', tr('step.details.copyLabel', { what: head }));
    copy.onclick = async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(text); copy.textContent = tr('step.details.copied'); setTimeout(() => { copy.textContent = tr('step.details.copy'); }, 1200); } catch { /* no clipboard */ } };
    box.append(el('div', { className: 'step-sec-head' }, el('span', { textContent: head }), copy), el('pre', { className: mono ? 'step-pre' : 'step-pre plain', textContent: clipText(text) }));
    return box;
  }
  function buildMore(row) {
    const s = row._s || {};
    let more = row.querySelector(':scope > .step-more');
    if (!more) { more = el('div', { className: 'step-more' }); more.addEventListener('click', (e) => e.stopPropagation()); row.append(more); }
    more.textContent = '';
    const inp = inputText(s);
    if (inp.text) more.append(section(inp.head, inp.text));
    if (s.error) more.append(section(tr('step.details.error'), window.stepLabels.redact(s.error)));
    else if (typeof s.output === 'string' && s.output) more.append(section(tr('step.details.output'), window.stepLabels.redact(s.output)));
    else if (s.done && s.hasOutputSlot) more.append(el('div', { className: 'step-none', textContent: tr('step.details.none') }));
    return more;
  }
  function toggle(row, force) {
    const open = force ?? row.getAttribute('aria-expanded') !== 'true';
    row.setAttribute('aria-expanded', String(open));
    row.classList.toggle('open', open);
    if (open) buildMore(row); else row.querySelector(':scope > .step-more')?.remove();
  }
  let wired = new WeakSet();
  function init(messages) {
    if (!messages || wired.has(messages)) return;
    wired.add(messages);
    messages.addEventListener('click', (e) => { const row = e.target.closest?.('.step[data-more]'); if (row && !e.target.closest('.step-more, button, a')) toggle(row); });
    messages.addEventListener('keydown', (e) => {
      if ((e.key !== 'Enter' && e.key !== ' ') || e.target.closest?.('.step-more, button, a')) return;
      const row = e.target.closest?.('.step[data-more]');
      if (row && row === e.target) { e.preventDefault(); toggle(row); }
    });
  }

  // ---- grouping: consecutive rows with the same key are one entry
  function entryLabel(entry) { return window.stepLabels && entry.members.length > 1 ? SL().groupLabel(entry.info, entry.members.length, entry.members[0]._s?.baseLabel || entry.members[0].firstChild.textContent) : entry.members[0].firstChild.textContent; }
  function refreshEntry(entry) {
    if (entry.members.length < 2 || !entry.sum) return;
    const running = entry.members.some((m) => m.classList.contains('running'));
    const failed = entry.members.every((m) => m.classList.contains('failed'));
    entry.sum.className = `step ${running ? 'running' : failed ? 'failed' : 'done'}${entry.group.open ? ' open' : ''}`;
    const text = entryLabel(entry);
    entry.sum.firstChild.textContent = text;
    entry.sum.title = text;
  }
  function addToEntry(entry, row) {
    entry.members.push(row);
    if (entry.members.length === 2) {
      const first = entry.members[0];
      const group = el('details', { className: 'step-group live' });
      const sum = el('summary', { className: 'step running' });
      sum.innerHTML = '<span class="step-detail"></span>';
      const items = el('div', { className: 'step-items' });
      first.replaceWith(group);
      items.append(first);
      group.append(sum, items);
      Object.assign(entry, { el: group, sum, items, group });
      group._entry = entry;
    }
    entry.items.append(row);
    refreshEntry(entry);
  }
  // Puts `row` in `container` ({ entries, list | host }), joining the entry before it when it is the same kind and target.
  function place(container, row, info, tail) {
    const last = container.entries[container.entries.length - 1];
    if (last && info && last.info && last.info.key === info.key && (!tail || tail(last.el))) { addToEntry(last, row); return last; }
    const entry = { info, members: [row], el: row };
    container.entries.push(entry);
    if (container.list) container.list.append(row); else container.host.append(row);
    return entry;
  }

  // ---- cards
  const SURF = { browser: { key: 'browser', icon: 'browser', title: 'card.browser' }, shell: { key: 'shell' } };
  let observer = null;
  const seen = new Set();
  let visTimer = 0;
  function reportVisible() {
    clearTimeout(visTimer);
    visTimer = setTimeout(() => { try { window.assistant?.thumbsVisible?.(!document.hidden && seen.size > 0); } catch { /* old preload */ } }, 150);
  }
  function watch(card) {
    if (typeof IntersectionObserver !== 'function') return;
    if (!observer) {
      observer = new IntersectionObserver((list) => { for (const e of list) { if (e.isIntersecting) seen.add(e.target); else seen.delete(e.target); } reportVisible(); });
      document.addEventListener('visibilitychange', reportVisible);
    }
    observer.observe(card);
  }
  function unwatch(card) { if (observer) { observer.unobserve(card); seen.delete(card); reportVisible(); } }

  function makeCard(turn, surface, host) {
    const el0 = el('section', { className: 'act-card' });
    el0.dataset.surface = surface;
    el0.dataset.state = 'working';
    el0.innerHTML = '<div class="act-head"><span class="act-icon"></span><div class="act-titles"><div class="act-title"></div><div class="act-sub"></div></div></div>'
      + '<div class="act-shot" hidden><img class="act-thumb" alt="" decoding="async"></div>'
      + '<button type="button" class="act-btn" hidden></button>'
      + '<span class="act-live" role="status"></span>'
      + '<details class="act-steps"><summary></summary><div class="act-list"></div></details>';
    const card = { el: el0, surface, entries: [], list: el0.querySelector('.act-list'), count: 0, running: 0, stopped: false, first: '', sum: el0.querySelector('summary'), sub: el0.querySelector('.act-sub'), title: el0.querySelector('.act-title'), icon: el0.querySelector('.act-icon'), shot: el0.querySelector('.act-shot'), img: el0.querySelector('.act-thumb'), btn: el0.querySelector('.act-btn'), task: '', tab: null, file: null, shell: false, writes: false, latest: '', live: el0.querySelector('.act-live'), said: '' };
    el0.setAttribute('role', 'group');
    card.btn.onclick = () => openIt(card);
    card.shot.onclick = () => openIt(card); // (the picture does what the button does)
    host.append(el0);
    turn.cards ||= [];
    turn.cards.push(card);
    if (surface === 'browser') watch(el0);
    refreshCard(turn, card);
    return card;
  }
  function stateOf(turn, card) {
    if (card.running > 0) return (turn?.approvalsWaiting?.() && card === turn.card) ? 'approval' : 'working';
    return card.stopped ? 'stopped' : 'completed';
  }
  function refreshCard(turn, card) {
    const state = stateOf(turn, card);
    if (card.el.dataset.state !== state) {
      card.el.dataset.state = state;
      if (state !== 'working' && state !== 'approval' && card.surface === 'browser') unwatch(card.el);
    }
    const kind = card.surface === 'browser' ? 'browser' : card.writes && !card.shell ? 'files' : 'terminal'; // "Computer", or "Files changed" when only files were written
    if (card.icon.dataset.k !== kind) { card.icon.dataset.k = kind; card.icon.innerHTML = ICONS[kind]; card.title.textContent = tr(`card.${kind}`); }
    const task = card.surface === 'browser' ? (card.task || card.first) : card.first;
    const sub = task ? tr('card.sub', { state: tr(`card.state.${state}`), task }) : tr(`card.state.${state}`);
    if (card.sub.textContent !== sub) { card.sub.textContent = sub; card.el.setAttribute('aria-label', tr('card.aria', { title: card.title.textContent, sub })); }
    const steps = tr(card.count === 1 ? 'card.steps.one' : 'card.steps.other', { count: card.count });
    const sum = state === 'working' && card.latest ? tr('card.steps.latest', { steps, latest: card.latest }) : steps;
    if (card.sum.textContent !== sum) card.sum.textContent = sum;
    // The button: a browser card opens its tab once it has one; a file card opens its file.
    let label = '';
    if (card.surface === 'browser' && card.tab) label = tr('card.openPreview');
    else if (card.file) label = tr(card.file.canTab || card.file.canSystem ? 'card.openFile' : 'card.showFolder');
    card.btn.hidden = !label;
    if (label && card.btn.textContent !== label) { card.btn.textContent = label; card.btn.title = card.surface === 'browser' ? tr('card.openPreview.title') : ''; }
    // The screen reader hears a card's state change (Working, Needs your OK, Done, Stopped), once each, never its steps.
    if (card.said !== state) { card.said = state; card.live.textContent = tr('card.live', { title: card.title.textContent, state: tr(`card.state.${state}`) }); }
  }
  function openIt(card) {
    const api = window.assistant;
    if (card.surface === 'browser' && card.tab) { Promise.resolve(api?.openPreview?.({ tabId: card.tab.tabId ?? null, url: card.tab.url || '' })).catch(() => {}); return; }
    if (card.file) { const f = card.file; Promise.resolve(api?.files?.open?.(f.id, f.canTab ? 'tab' : f.canSystem ? 'system' : 'reveal')).catch(() => {}); }
  }
  function setThumb(card, src) {
    if (!src) return;
    if (card.img.getAttribute('src') !== src) card.img.src = src;
    if (card.shot.hidden) { card.shot.hidden = false; card.img.alt = tr('card.thumb.alt'); }
  }

  // ---- the turn's steps
  // opts: { append(el) puts a plain node in the chat above the working line, label (the engine's own), task }
  function endCard(turn) { if (turn) { turn.card = null; turn.plain = null; } }
  function labelFor(event) {
    const own = window.stepLabels && SL().label(event.name, event.input || {});
    return own || event.label || '';
  }
  function add(turn, event, opts) {
    init(opts.messages);
    const label = opts.fallback ? (labelFor(event) || opts.fallback) : labelFor(event);
    const running = Boolean(event.id);
    const data = { name: event.name, input: event.input && typeof event.input === 'object' ? event.input : null, label, baseLabel: label, hasOutputSlot: running };
    const row = makeRow(label, running, data);
    const surface = window.stepLabels.surfaceOf(event.name);
    const info = SL().groupInfo(event.name, data.input, label);
    const tail = (e) => !turn.working || e.nextElementSibling === turn.working || !e.nextElementSibling;
    if (surface) {
      let card = turn.card;
      if (!card || card.surface !== surface || !card.el.isConnected) {
        card = makeCard(turn, surface, { append: (n) => opts.append(n) });
        turn.card = card;
        if (!turn.pendingThumb) turn.pendingThumb = null;
        if (surface === 'browser') { card.task = SL().taskName(opts.task || ''); if (turn.lastThumb) { card.tab = turn.lastThumb.tab; setThumb(card, turn.lastThumb.src); } }
      }
      if (surface === 'shell' && window.stepLabels.SHELL.has(String(event.name))) card.shell = true;
      if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(String(event.name))) card.writes = true;
      if (!card.first) card.first = label;
      card.count++;
      if (running) card.running++;
      card.latest = label;
      place(card, row, info);
      refreshCard(turn, card);
      row._card = card;
    } else {
      const plain = (turn.plain ||= { entries: [], host: { append: (n) => opts.append(n) } });
      place(plain, row, info, tail);
    }
    row._turn = turn;
    return row;
  }
  function update(turn, row, event) {
    const label = labelFor(event);
    if (label) { setLabel(row, label); if (row._s) row._s.baseLabel = label; }
    if (row._s && event.input && typeof event.input === 'object') row._s.input = event.input;
    if (row._s?.input && !row.dataset.more) { row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-expanded', 'false'); row.dataset.more = '1'; }
    const card = row._card;
    if (card) { card.latest = row.firstChild.textContent; if (card.count === 1) card.first = card.latest; refreshCard(turn, card); }
    groupRefresh(row);
  }
  function groupRefresh(row) { const g = row.parentElement?.closest?.('details.step-group.live'); if (g && g._entry) refreshEntry(g._entry); }
  // A step finished. Returns true when it showed its own plain failure (builtin tools), so the caller skips the generic reason line.
  function done(turn, row, event) {
    const s = row._s || (row._s = {});
    s.done = true;
    if (typeof event.output === 'string') s.output = event.output;
    if (!event.ok && event.error) s.error = String(event.error);
    let plain = false;
    const known = window.stepLabels && SL().label(s.name, s.input || {});
    if (!event.ok && !event.stopped && event.error && known) {
      const f = SL().failure(s.name, s.input || {}, event.error, s.baseLabel);
      const detail = row.firstChild;
      detail.textContent = f.text;
      if (f.why) detail.append(el('span', { className: 'step-why', textContent: `: ${f.why}` }));
      row.title = f.why ? `${f.text}: ${f.why}` : f.text;
      plain = true;
    }
    if (row.classList.contains('open')) buildMore(row);
    const card = row._card;
    if (card) { if (card.running > 0) card.running--; if (event.stopped) card.stopped = true; refreshCard(turn, card); }
    return plain;
  }
  // The turn ended: steps still running were stopped.
  function finalize(turn) {
    for (const card of turn?.cards || []) {
      for (const row of card.list.querySelectorAll('.step.stopped')) { card.stopped = true; row._card && (row._card.running = Math.max(0, row._card.running - 1)); }
      card.running = 0;
      refreshCard(turn, card);
    }
  }
  function refreshAll(turn) { for (const card of turn?.cards || []) refreshCard(turn, card); }

  // A thumbnail of the tab the AI works in: { data (base64 jpeg), url, title, tabId }.
  function thumb(turn, event) {
    const src = `data:image/jpeg;base64,${event.data}`;
    const tab = { tabId: event.tabId ?? null, url: event.url || '', title: event.title || '' };
    turn.lastThumb = { src, tab };
    const card = [...(turn.cards || [])].reverse().find((c) => c.surface === 'browser');
    if (!card) return;
    card.tab = tab;
    setThumb(card, src);
    refreshCard(turn, card);
  }
  // A file the AI made: the latest shell card offers it (Open file / Show in folder) and, for a picture, shows it.
  function fileMade(turn, file) {
    const card = [...(turn.cards || [])].reverse().find((c) => c.surface === 'shell');
    if (!card || !file) return;
    card.file = file;
    refreshCard(turn, card);
    if (file.kind === 'image' && file.trusted && file.previewable) Promise.resolve(window.assistant?.files?.preview?.(file.id)).then((got) => { if (got?.dataUrl) setThumb(card, got.dataUrl); }).catch(() => {});
  }

  // ---- a reopened chat: the steps of one saved reply as nodes (cards for the browser and the shell, a folded group for the rest)
  function restoreNodes(item) {
    const tools = Array.isArray(item.tools) ? item.tools : [];
    const out = [];
    const turn = { cards: [], card: null, plain: null, working: null };
    const host = { append: (n) => out.push(n) };
    let legacy = null;
    const flushLegacy = () => { legacy = null; };
    for (const tool of tools) {
      const name = String(tool.name || '');
      let input = tool.input && typeof tool.input === 'object' ? tool.input : null;
      if (!input && /^(Bash|PowerShell)$/.test(name) && /^Running /.test(tool.label || '')) input = { command: String(tool.label).replace(/^Running /, '') };
      const label = (window.stepLabels && SL().label(name, input || {})) || tool.label || name;
      const surface = name ? window.stepLabels.surfaceOf(name) : null;
      const data = { name, input, label, baseLabel: label, done: true };
      const row = makeRow(label, false, data);
      if (tool.ok === false) { row.className = 'step failed restored'; } else row.className = 'step done restored';
      const info = SL().groupInfo(name, input, label);
      if (surface) {
        flushLegacy();
        let card = turn.card;
        if (!card || card.surface !== surface) { card = makeCard(turn, surface, host); turn.card = card; if (surface === 'browser') unwatch(card.el); }
        if (surface === 'shell' && window.stepLabels.SHELL.has(name)) card.shell = true;
        if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) card.writes = true;
        if (!card.first) card.first = label;
        card.count++;
        place(card, row, info);
        row._card = card;
      } else {
        turn.card = null;
        if (!legacy) {
          const group = el('details', { className: 'step-group restored' });
          const summary = el('summary', { className: 'step done restored' });
          summary.innerHTML = '<span class="step-detail"></span>';
          group.append(summary, el('div', { className: 'step-items' }));
          legacy = { group, summary, n: 0, items: group.lastChild };
          out.push(group);
        }
        legacy.n++;
        legacy.items.append(row);
        legacy.summary.firstChild.textContent = tr(legacy.n === 1 ? 'chat.usedActions.one' : 'chat.usedActions.other', { count: legacy.n });
      }
    }
    for (const card of turn.cards) { card.el.dataset.state = 'completed'; }
    const t = item.thumb;
    if (t && t.data) {
      const last = [...turn.cards].reverse().find((c) => c.surface === 'browser');
      if (last) { last.tab = { tabId: null, url: t.url || '', title: t.title || '' }; setThumb(last, `data:image/jpeg;base64,${t.data}`); }
    }
    for (const card of turn.cards) { card.running = 0; refreshCard(turn, card); if (card.surface === 'browser' && t?.url) { /* button shown by refreshCard when a tab is known */ } }
    return out;
  }

  window.stepUI = { init, makeRow, setLabel, add, update, done, endCard, finalize, refreshAll, thumb, fileMade, restoreNodes, toggle, labelFor };
})();
