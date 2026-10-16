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
  let observer = null;
  const seen = new Set();
  let visTimer = 0;
  function reportVisible(now = false) {
    clearTimeout(visTimer);
    const send = () => { try { window.assistant?.thumbsVisible?.(!document.hidden && seen.size > 0); } catch { /* old preload */ } };
    if (now) send(); // (a card appearing is seen at once; one leaving is reported a moment later)
    else visTimer = setTimeout(send, 150);
  }
  function watch(card) {
    if (typeof IntersectionObserver !== 'function') return;
    if (!observer) {
      observer = new IntersectionObserver((list) => { for (const e of list) { if (e.isIntersecting) seen.add(e.target); else seen.delete(e.target); } reportVisible(); });
      document.addEventListener('visibilitychange', reportVisible);
    }
    observer.observe(card);
    seen.add(card); // (a new card is on screen until the observer says otherwise)
    reportVisible(true);
  }
  function unwatch(card) { if (observer) { observer.unobserve(card); seen.delete(card); reportVisible(); } }

  function makeCard(turn, surface, host) {
    const el0 = el('section', { className: 'act-card' });
    el0.dataset.surface = surface;
    el0.dataset.state = ''; // (the first refresh sets it: a browser card starts being watched then)
    el0.innerHTML = '<div class="act-head"><span class="act-icon"></span><div class="act-titles"><div class="act-title"></div><div class="act-sub"></div><div class="act-tabref" hidden></div></div></div>'
      + '<div class="act-shot" hidden><img class="act-thumb" alt="" decoding="async"><div class="act-site"><img class="act-site-ico" alt="" hidden><span class="act-site-name"></span></div></div>'
      + '<div class="act-status" hidden><span class="act-dot" aria-hidden="true"></span><span class="act-status-text"></span></div>'
      + '<details class="act-tabs" hidden><summary class="act-tabs-head"></summary><div class="act-tabs-list"></div></details>'
      + '<div class="act-actions"><button type="button" class="act-btn" hidden></button>'
      + '<button type="button" class="act-toggle" hidden></button><button type="button" class="act-closeall" hidden></button></div>'
      + '<div class="act-tabs-note" hidden></div>'
      + '<span class="act-live" role="status" aria-live="polite"></span>'
      + '<details class="act-steps"><summary></summary><div class="act-list"></div></details>';
    const card = { el: el0, surface, entries: [], list: el0.querySelector('.act-list'), count: 0, running: 0, stopped: false, first: '', sum: el0.querySelector('summary'), sub: el0.querySelector('.act-sub'), tabref: el0.querySelector('.act-tabref'), title: el0.querySelector('.act-title'), icon: el0.querySelector('.act-icon'), shot: el0.querySelector('.act-shot'), img: el0.querySelector('.act-thumb'), site: el0.querySelector('.act-site'), siteIco: el0.querySelector('.act-site-ico'), siteName: el0.querySelector('.act-site-name'), status: el0.querySelector('.act-status'), statusText: el0.querySelector('.act-status-text'), tabsBox: el0.querySelector('.act-tabs'), tabsHead: el0.querySelector('.act-tabs-head'), tabsList: el0.querySelector('.act-tabs-list'), touched: [], tabEls: new Map(), tabsUser: false, liveAt: 0, liveText: '', liveTimer: 0, siteMode: false, btn: el0.querySelector('.act-btn'), task: '', tab: null, file: null, shell: false, writes: false, latest: '', live: el0.querySelector('.act-live'), said: '', toggle: el0.querySelector('.act-toggle'), closeAll: el0.querySelector('.act-closeall'), note: el0.querySelector('.act-tabs-note'), aiTabs: null, runId: null, closed: false };
    el0._card = card;
    el0.setAttribute('role', 'group');
    card.btn.onclick = () => openIt(card);
    card.toggle.onclick = () => toggleAiTabs(card);
    card.closeAll.onclick = () => closeAiTabs(card);
    card.shot.onclick = () => openIt(card); // (the picture does what the button does)
    card.tabsHead.addEventListener('click', () => { card.tabsUser = true; }); // (a card the user opened or folded stays as they left it)
    try { new MutationObserver(() => tabsCount(card)).observe(card.tabsList, { subtree: true, attributes: true, attributeFilter: ['data-state'] }); } catch { /* no observer */ }
    card.img.addEventListener('load', () => capSize(card)); // (shown at or below its own pixels, see capSize)
    host.append(el0);
    turn.cards ||= [];
    turn.cards.push(card);
    refreshCard(turn, card);
    return card;
  }
  function stateOf(turn, card) {
    // A card is working until the assistant's narration ends it (or the turn ends), however briefly no step runs between two steps.
    if (card.running > 0 || !card.ended) return (turn?.approvalsWaiting?.() && card === turn.card) ? 'approval' : 'working';
    return card.stopped ? 'stopped' : 'completed';
  }
  function refreshCard(turn, card) {
    const state = stateOf(turn, card);
    if (card.el.dataset.state !== state) {
      card.el.dataset.state = state;
      if (card.surface === 'browser') { if (state === 'working' || state === 'approval') watch(card.el); else unwatch(card.el); } // (a card on screen keeps its thumbnail refreshing; one that finished does not)
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
    if (card.surface === 'browser' && card.tab && !card.siteMode) label = tr('card.openPreview');
    else if (card.file) label = tr(card.file.canTab || card.file.canSystem ? 'card.openFile' : 'card.showFolder');
    card.btn.hidden = !label;
    if (label && card.btn.textContent !== label) { card.btn.textContent = label; card.btn.title = card.surface === 'browser' ? tr('card.openPreview.title') : ''; }
    refreshTabs(card, state);
    cardChip(card);
    if (card.surface === 'browser') statusBar(card, state);
    // The screen reader hears a card's state change (Working, Needs your OK, Done, Stopped), once each, never its steps.
    else if (card.said !== state) { card.said = state; card.live.textContent = tr('card.live', { title: card.title.textContent, state: tr(`card.state.${state}`) }); }
  }
  // ---- the tabs this turn opened or used: chips (tab-ref.js) in the order they were first touched, each marked open or closed
  // (a closed one reopens from its chip, an open one switches to it); folded when there are more than 4.
  const TABS_FOLDED = 4;
  const isClosedState = (st) => st === 'closed' || st === 'gone';
  function tabsCount(card) {
    if (!card.touched.length) return;
    let closed = 0;
    for (const w of card.tabEls.values()) {
      const c = w.querySelector('.tab-ref');
      const gone = Boolean(c) && isClosedState(c.dataset.state);
      if (gone) closed++;
      const st = gone ? 'closed' : 'open';
      if (w.dataset.state !== st) w.dataset.state = st; // (only on a change: the observer below watches data-state, a same-value write would call it again for ever)
      const label = tr(gone ? 'card.tabs.stateClosed' : 'card.tabs.stateOpen');
      const mark = w.querySelector('.act-tab-state');
      if (mark.textContent !== label) mark.textContent = label;
    }
    const head = closed ? tr('card.tabs.headClosed', { total: card.touched.length, closed }) : tr('card.tabs.head', { total: card.touched.length });
    if (card.tabsHead.textContent !== head) card.tabsHead.textContent = head;
  }
  // ids: tab ids; snap: what is known of them ({ id: { t, u, s } }), for the chip's name before the browser answers.
  function touchTabs(card, ids, snap) {
    if (!card || card.surface !== 'browser' || !window.tabRef) return;
    let added = false;
    for (const id of ids || []) {
      if (!Number.isInteger(id) || id < 0 || card.touched.includes(id) || card.touched.length >= 24) continue;
      const kept = snap && (snap[id] || snap[String(id)]) || null;
      const wrap = el('span', { className: 'act-tab' });
      wrap.append(window.tabRef.chip({ id, s: kept?.s || '' }, kept ? { t: kept.t || '', u: kept.u || '' } : null), el('span', { className: 'act-tab-state' }));
      card.tabsList.append(wrap);
      card.touched.push(id);
      card.tabEls.set(id, wrap);
      added = true;
    }
    if (!added) return;
    card.tabsBox.hidden = false;
    if (!card.tabsUser) card.tabsBox.open = card.touched.length <= TABS_FOLDED;
    tabsCount(card);
  }
  // The preview is shown at or below its own pixels: its width in CSS pixels is the picture's width over the display's scale, never above CAP.
  const CAP = 340;
  function capSize(card) {
    const w = card.img.naturalWidth;
    if (!w) return;
    card.shot.style.maxWidth = Math.min(CAP, Math.floor(w / Math.max(1, window.devicePixelRatio || 1))) + 'px';
  }
  // The status bar of a Browser card: what the AI is doing right now, in the words of its steps. It replaces itself on every step; a screen
  // reader hears it (aria-live polite on the card's hidden live region) at most every 1.5 s, and a change of state (Done, Needs you) at once.
  const trimStep = (s) => String(s || '').replace(/[\s.\u2026]+$/, '');
  function siteOf(card) { const t = card.tab; if (!t) return ''; try { return t.url ? new URL(t.url).host.replace(/^www\./, '') : ''; } catch { return ''; } }
  function statusFor(card, state) {
    const step = trimStep(card.latest);
    if (state === 'stopped') return tr('card.status.stopped');
    if (state === 'completed') return step ? tr('card.status.done', { result: step }) : tr('card.state.completed');
    if (state === 'approval') return tr('card.status.needs', { why: step ? tr('card.status.needsWhy', { step }) : tr('card.status.needsOk') });
    if (!step) return tr('card.status.starting');
    const site = card.siteMode ? '' : siteOf(card);
    return site && !step.toLowerCase().includes(site.toLowerCase()) ? tr('card.status.workingOn', { step, site }) : tr('card.status.working', { step });
  }
  function statusBar(card, state) {
    const text = statusFor(card, state);
    card.status.hidden = false;
    card.status.dataset.state = state;
    if (card.statusText.textContent !== text) card.statusText.textContent = text;
    if (card.liveText === text) return;
    const write = () => { card.liveTimer = 0; card.liveAt = Date.now(); card.liveText = text; card.live.textContent = text; };
    clearTimeout(card.liveTimer);
    const wait = card.liveAt + 1500 - Date.now();
    if (state !== 'working' || wait <= 0) write(); else card.liveTimer = setTimeout(() => { statusBar(card, card.el.dataset.state); }, wait);
  }
  // The tab a Browser card works in, as a chip (live title; clicking it switches to the tab).
  function cardChip(card) {
    const t = card.tab;
    if (card.surface === 'browser' && card.siteMode) { card.tabref.hidden = true; card.tabref.dataset.sig = ''; return; }
    if (card.surface !== 'browser' || !t || !window.tabRef) return;
    const sig = `${t.tabId ?? ''}|${t.s || ''}|${t.tabId == null ? t.url : ''}`;
    if (card.tabref.dataset.sig === sig) return;
    if (t.tabId == null && !t.url) return;
    card.tabref.dataset.sig = sig;
    card.tabref.textContent = '';
    card.tabref.append(window.tabRef.chip(t.tabId != null ? { id: t.tabId, s: t.s || '' } : null, { t: t.title, u: t.url }));
    card.tabref.hidden = false;
  }
  // ---- the tabs the AI opened: hide / show them in the strip (the sidebar's own toggle, the hideAiTabs setting) and close them with Undo
  const hidingTabs = () => window.lumenHideAiTabs === true;
  function refreshTabs(card, state) {
    if (card.surface !== 'browser') return;
    const n = Number(card.aiTabs) || 0;
    const on = hidingTabs();
    card.toggle.hidden = !(n > 0 || on); // (while the toggle is on it stays, so it can be turned off)
    if (!card.toggle.hidden) {
      const label = tr(on ? 'card.aiTabs.show' : 'card.aiTabs.hide');
      const text = n > 0 ? tr('card.aiTabs.count', { label, count: n }) : label;
      if (card.toggle.textContent !== text) card.toggle.textContent = text;
      card.toggle.setAttribute('aria-pressed', String(on));
      card.toggle.title = tr('sidebar.hideAiTabs.menu.hide');
    }
    card.closeAll.hidden = !(n > 0 && card.runId != null && state !== 'working' && state !== 'approval' && !card.closed); // (after the run: "Close them")
    if (!card.closeAll.hidden && !card.closeAll.textContent) { card.closeAll.textContent = tr('card.aiTabs.close'); card.closeAll.setAttribute('aria-label', tr('card.aiTabs.closeLabel')); }
  }
  async function toggleAiTabs(card) {
    const api = window.browser?.hideAiTabs ? (on) => window.browser.hideAiTabs(on) : window.assistant?.hideAiTabs;
    if (!api) return;
    card.toggle.disabled = true;
    try {
      const on = await Promise.resolve(api(!hidingTabs()));
      if (typeof on === 'boolean' && window.lumenHideAiTabs !== on) { window.lumenHideAiTabs = on; document.dispatchEvent(new Event('lumen:hide-ai-tabs')); } // (the sidebar's toggle and the strip follow)
    } catch { /* unchanged */ } finally { card.toggle.disabled = false; }
  }
  const pluralTabs = (base, n) => tr(`${base}.${n === 1 ? 'one' : 'other'}`, { count: n });
  async function closeAiTabs(card) {
    const api = window.assistant;
    if (!api?.closeAiTabs || card.runId == null) return;
    card.closeAll.disabled = true;
    const result = await Promise.resolve(api.closeAiTabs({ runId: card.runId })).catch(() => null);
    card.closeAll.disabled = false;
    card.closed = true;
    card.note.hidden = false;
    card.note.textContent = '';
    if (!result?.closed) { card.note.textContent = tr('chat.aiTabs.none'); card.aiTabs = 0; refreshCard(null, card); return; }
    card.aiTabs = 0;
    card.note.append(el('span', { textContent: pluralTabs('chat.aiTabs.closed', result.closed) + ' ' }));
    const undo = el('button', { type: 'button', className: 'act-undo', textContent: tr('chat.aiTabs.undo') });
    undo.onclick = async () => {
      undo.disabled = true;
      const back = await Promise.resolve(api.undoCloseAiTabs?.(result.token)).catch(() => null);
      card.note.textContent = back?.reopened ? pluralTabs('chat.aiTabs.reopened', back.reopened) : tr('chat.aiTabs.nothingReopened');
      card.closed = false;
    };
    card.note.append(undo);
    refreshCard(null, card);
  }
  document.addEventListener('lumen:hide-ai-tabs', () => { for (const c of document.querySelectorAll('.act-card[data-surface="browser"]')) if (c._card) refreshTabs(c._card, c.dataset.state); });

  function openIt(card) {
    const api = window.assistant;
    if (card.surface === 'browser' && card.tab) { Promise.resolve(api?.openPreview?.({ tabId: card.tab.tabId ?? null, url: card.tab.url || '' })).catch(() => {}); return; }
    if (card.file) { const f = card.file; Promise.resolve(api?.files?.open?.(f.id, f.canTab ? 'tab' : f.canSystem ? 'system' : 'reveal')).catch(() => {}); }
  }
  function setThumb(card, src) {
    if (!src) return;
    card.siteMode = false;
    card.shot.dataset.mode = 'frame';
    if (card.img.getAttribute('src') !== src) card.img.src = src;
    if (card.shot.hidden) { card.shot.hidden = false; card.img.alt = tr('card.thumb.alt'); }
  }
  // The AI moved to another tab: the old picture must not stay under the new tab's name. A blank (the picture comes in a moment).
  function setPending(card) {
    card.siteMode = false;
    if (card.shot.hidden) return;
    card.shot.dataset.mode = 'pending';
    card.img.removeAttribute('src');
  }
  // A step that reads an address with no tab (read_urls): "Reading <site>" with its icon, no picture of another tab.
  function setSite(card, event) {
    card.siteMode = true;
    card.shot.hidden = false;
    card.shot.dataset.mode = 'site';
    card.img.removeAttribute('src');
    card.siteName.textContent = tr('card.site.reading', { site: event.title || '' });
    const icon = typeof event.favicon === 'string' ? event.favicon : '';
    card.siteIco.hidden = !icon;
    if (icon) card.siteIco.src = icon; else card.siteIco.removeAttribute('src');
    card.shot.style.maxWidth = '';
  }

  // ---- the turn's steps
  // opts: { append(el) puts a plain node in the chat above the working line, label (the engine's own), task }
  // The assistant said something between steps: the plain rows end there, the card does not. One AI turn is one Browser card that keeps
  // updating until the whole turn ends (finalize); a new card starts only when the surface changes.
  function endCard(turn) { if (!turn) return; turn.plain = null; }
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
    window.tabRef?.forStep(row, event.name, data.input, null); // [tab chips] a step that names a tab
    const tail = (e) => !turn.working || e.nextElementSibling === turn.working || !e.nextElementSibling;
    if (surface) {
      let card = turn.card;
      if (!card || card.surface !== surface || !card.el.isConnected) {
        if (card && !card.ended) { card.ended = true; refreshCard(turn, card); } // (the work moved to another surface: that card is done)
        card = makeCard(turn, surface, { append: (n) => opts.append(n) });
        turn.card = card;
        if (!turn.pendingThumb) turn.pendingThumb = null;
        if (surface === 'browser') { card.task = SL().taskName(opts.task || ''); if (turn.lastThumb) { card.tab = turn.lastThumb.tab; setThumb(card, turn.lastThumb.src); } }
      }
      if (surface === 'shell' && window.stepLabels.SHELL.has(String(event.name))) card.shell = true;
      if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(String(event.name))) card.writes = true;
      if (opts.runId != null && card.runId == null) card.runId = opts.runId;
      if (!card.first) card.first = label;
      card.count++;
      if (running) card.running++;
      card.latest = label;
      place(card, row, info);
      touchTabs(card, window.tabMarker ? window.tabMarker.stepTabs(event.name, data.input) : []);
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
    if (row._s?.input) window.tabRef?.forStep(row, row._s.name, row._s.input, null);
    if (row._s?.input && !row.dataset.more) { row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-expanded', 'false'); row.dataset.more = '1'; }
    const card = row._card;
    if (card) { card.latest = row.firstChild.textContent; if (card.count === 1) card.first = card.latest; if (event.input && window.tabMarker) touchTabs(card, window.tabMarker.stepTabs(row._s?.name, event.input)); refreshCard(turn, card); }
    groupRefresh(row);
  }
  function groupRefresh(row) { const g = row.parentElement?.closest?.('details.step-group.live'); if (g && g._entry) refreshEntry(g._entry); }
  // A step finished. Returns true when it showed its own plain failure (builtin tools), so the caller skips the generic reason line.
  function done(turn, row, event) {
    const s = row._s || (row._s = {});
    s.done = true;
    if (typeof event.output === 'string') s.output = event.output;
    if (!event.ok && event.error) s.error = String(event.error);
    if (Number.isInteger(event.tabId)) window.tabRef?.forStep(row, s.name, s.input, null, event.tabId); // [tab chips] the tab open_tab made
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
    if (card) { if (card.running > 0) card.running--; if (event.stopped) card.stopped = true; if (Number.isInteger(event.tabId)) touchTabs(card, [event.tabId]); refreshCard(turn, card); }
    return plain;
  }
  // The turn ended: steps still running were stopped.
  function finalize(turn, event) {
    for (const card of turn?.cards || []) {
      if (card.surface === 'browser' && Number.isFinite(event?.aiTabCount)) card.aiTabs = event.aiTabCount; // (the run is over: the tab it worked in counts now)
      for (const row of card.list.querySelectorAll('.step.stopped')) { card.stopped = true; row._card && (row._card.running = Math.max(0, row._card.running - 1)); }
      card.running = 0;
      card.ended = true;
      refreshCard(turn, card);
    }
  }
  function refreshAll(turn) { for (const card of turn?.cards || []) refreshCard(turn, card); }

  // A thumbnail of the tab the AI works in: { data (base64 jpeg), url, title, tabId }.
  function thumb(turn, event) {
    const tab = { tabId: event.tabId ?? null, url: event.url || '', title: event.title || '' };
    const kind = event.kind || 'frame'; // 'frame' (a picture), 'pending' (the tab being acted on changed), 'site' (an address read with no tab)
    const src = kind === 'frame' && event.data ? `data:image/jpeg;base64,${event.data}` : '';
    turn.lastThumb = kind === 'frame' ? { src, tab } : null;
    const card = [...(turn.cards || [])].reverse().find((c) => c.surface === 'browser');
    if (!card) return;
    card.tab = tab;
    if (Number.isInteger(event.tabId)) touchTabs(card, [event.tabId], { [event.tabId]: { t: tab.title, u: tab.url } });
    if (Number.isFinite(event.aiTabs)) card.aiTabs = event.aiTabs;
    if (kind === 'site') setSite(card, event); else if (kind === 'pending') setPending(card); else setThumb(card, src);
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
      window.tabRef?.forStep(row, name, input, item.tabs, Number.isInteger(tool.tab) ? tool.tab : null);
      if (surface) {
        flushLegacy();
        let card = turn.card;
        if (!card || card.surface !== surface) { card = makeCard(turn, surface, host); turn.card = card; if (surface === 'browser') unwatch(card.el); }
        if (surface === 'shell' && window.stepLabels.SHELL.has(name)) card.shell = true;
        if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) card.writes = true;
        if (!card.first) card.first = label;
        card.count++;
        card.latest = label;
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
    for (const card of turn.cards) { card.ended = true; if (card.surface === 'browser') card.task = item.task || ''; }
    const t = item.thumb;
    if (t && t.data) {
      const last = [...turn.cards].reverse().find((c) => c.surface === 'browser');
      if (last) { last.tab = { tabId: Number.isInteger(t.tabId) ? t.tabId : null, s: t.s || '', url: t.url || '', title: t.title || '' }; setThumb(last, `data:image/jpeg;base64,${t.data}`); }
    }
    const touchedIds = Array.isArray(item.touched) ? item.touched.filter(Number.isInteger) : [];
    const lastBrowser = [...turn.cards].reverse().find((c) => c.surface === 'browser');
    if (lastBrowser && touchedIds.length) touchTabs(lastBrowser, touchedIds, item.tabs || null);
    for (const card of turn.cards) { card.running = 0; refreshCard(turn, card); if (card.surface === 'browser' && t?.url) { /* button shown by refreshCard when a tab is known */ } }
    return out;
  }

  window.stepUI = { init, makeRow, setLabel, add, update, done, endCard, finalize, refreshAll, thumb, fileMade, restoreNodes, toggle, labelFor };
})();
