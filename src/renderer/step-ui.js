// How the AI's steps look in the chat, in the sidebar and the full-page chat alike (loaded after step-labels.js, before chat-core.js):
//   - one readable line per step; click or Enter opens the exact command / input and the output (copyable), collapsed by default
//   - consecutive steps of one kind and target are one row with a count ("Read 4 pages"), expanding to its members
//   - the steps of one AI turn (the browser, the shell and files, other programs on the PC) sit in ONE activity card: its icon and title follow
//     the step being done (Browser, Computer, Files), a preview of what is acted on (the tab, the program's window, a picture), a status bar
//     ("Reading PDF.pdf"), the assistant's narration as its live line, the approvals ("Allowed automatically") as small rows, and every step,
//     each marked with its surface, folded under "N steps". The card says Done when the whole turn ends.
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
    word: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.500h6.500L18 8v11.500a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z"/><path d="M13.500 3.500V8H18M9 11.500h6M9 14.500h6M9 17.500h3.500"/></svg>', // a page of text: Word work (a document)
  };
  ICONS.tool = ICONS.terminal; // (a step that is on no surface: the card names it "Working")

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
  function setLabel(row, label) { row.firstChild.textContent = label; row.title = row.dataset.surfLabel ? `${label} (${row.dataset.surfLabel})` : label; if (row._s) row._s.label = label; }

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
  function entryLabel(entry) { return window.stepLabels && entry.members.length > 1 ? SL().groupLabel(entry.info, entry.members.length, entry.members[0]._s?.baseLabel || entry.members[0].firstChild.textContent, entry.members.some((m) => m.classList.contains('running'))) : entry.members[0].firstChild.textContent; }
  function refreshEntry(entry) {
    if (entry.members.length < 2 || !entry.sum) return;
    const running = entry.members.some((m) => m.classList.contains('running'));
    const failed = entry.members.every((m) => m.classList.contains('failed'));
    entry.sum.className = `step ${running ? 'running' : failed ? 'failed' : 'done'}${entry.group.open ? ' open' : ''}`;
    const text = entryLabel(entry);
    entry.sum.firstChild.textContent = text;
    entry.sum.title = text;
    groupTime(entry, running);
  }
  // A group's time: from the first member's start to the last one's end (members may run in parallel); ticking while it runs.
  function groupTime(entry, running) {
    const slot = entry.sum.querySelector('.step-time');
    if (!slot) return;
    const starts = entry.members.map((m) => Number(m.dataset.t0 || m.dataset.start || 0)).filter(Boolean);
    if (running) { if (starts.length) entry.sum.dataset.t0 = String(Math.min(...starts)); return; } // (the step clock ticks it)
    delete entry.sum.dataset.t0;
    const ends = entry.members.map((m) => Number(m.dataset.t1 || 0)).filter(Boolean);
    if (!starts.length || ends.length < entry.members.length || !window.stepTime) { slot.textContent = ''; return; }
    const text = window.stepTime.format(Math.max(...ends) - Math.min(...starts));
    slot.textContent = text;
    slot.title = text ? tr('chat.step.took', { time: text }) : '';
  }
  function addToEntry(entry, row) {
    entry.members.push(row);
    if (entry.members.length === 2) {
      const first = entry.members[0];
      const group = el('details', { className: 'step-group live' });
      const sum = el('summary', { className: 'step running' });
      sum.innerHTML = '<span class="step-detail"></span><span class="step-time"></span>';
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
      + '<div class="act-shot2" hidden><img class="act-thumb2" alt="" decoding="async"><div class="act-page" hidden></div></div>'
      + '<div class="act-status" hidden><span class="act-dot" aria-hidden="true"></span><span class="act-status-text"></span></div>'
      + '<div class="act-say" hidden></div>'
      + '<div class="act-files" hidden></div>'
      + '<details class="act-tabs" hidden><summary class="act-tabs-head"></summary><div class="act-tabs-list"></div></details>'
      + '<div class="act-actions"><button type="button" class="act-btn" hidden></button><button type="button" class="act-resume" hidden></button><button type="button" class="act-stop" hidden></button>'
      + '<button type="button" class="act-toggle" hidden></button><button type="button" class="act-closeall" hidden></button></div>'
      + '<div class="act-tabs-note" hidden></div>'
      + '<span class="act-live" role="status" aria-live="polite"></span>'
      + '<details class="act-steps"><summary></summary><div class="act-list"></div></details>';
    const card = { el: el0, surface, entries: [], page: el0.querySelector('.act-page'), list: el0.querySelector('.act-list'), count: 0, running: 0, stopped: false, first: '', sum: el0.querySelector('.act-steps > summary'), sub: el0.querySelector('.act-sub'), tabref: el0.querySelector('.act-tabref'), title: el0.querySelector('.act-title'), icon: el0.querySelector('.act-icon'), shot: el0.querySelector('.act-shot'), img: el0.querySelector('.act-thumb'), site: el0.querySelector('.act-site'), siteIco: el0.querySelector('.act-site-ico'), siteName: el0.querySelector('.act-site-name'), status: el0.querySelector('.act-status'), statusText: el0.querySelector('.act-status-text'), shot2: el0.querySelector('.act-shot2'), img2: el0.querySelector('.act-thumb2'), say: el0.querySelector('.act-say'), filesBox: el0.querySelector('.act-files'), files: [], linkKey: '', sayText: '', resumeBtn: el0.querySelector('.act-resume'), stopBtn: el0.querySelector('.act-stop'), hadBrowser: surface === 'browser', firstSurface: surface, app: null, shellKind: 'terminal', tabsBox: el0.querySelector('.act-tabs'), tabsHead: el0.querySelector('.act-tabs-head'), tabsList: el0.querySelector('.act-tabs-list'), touched: [], tabEls: new Map(), tabsUser: false, liveAt: 0, liveText: '', liveTimer: 0, siteMode: false, btn: el0.querySelector('.act-btn'), task: '', tab: null, file: null, shell: false, writes: false, latest: '', live: el0.querySelector('.act-live'), said: '', toggle: el0.querySelector('.act-toggle'), closeAll: el0.querySelector('.act-closeall'), note: el0.querySelector('.act-tabs-note'), aiTabs: null, runId: null, closed: false };
    el0._card = card;
    el0.setAttribute('role', 'group');
    card.btn.onclick = () => openIt(card);
    card.resumeBtn.textContent = tr('desktopcard.resume');
    card.stopBtn.textContent = tr('desktopcard.stop');
    card.resumeBtn.onclick = () => window.assistant?.desktopControl?.('resume');
    card.stopBtn.onclick = () => window.assistant?.desktopControl?.('stop');
    card.toggle.onclick = () => toggleAiTabs(card);
    card.closeAll.onclick = () => closeAiTabs(card);
    card.shot.onclick = () => openIt(card); // (the picture does what the button does)
    card.shot2.onclick = () => { if (card.surface === 'app' && card.app?.id) openIt(card); }; // (a program's picture, or Word's page: a click goes to the program)
    card.shot2.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === card.shot2 && card.shot2.getAttribute('role') === 'button') { e.preventDefault(); openIt(card); } });
    card.head = el0.querySelector('.act-head');
    card.head.addEventListener('click', (e) => { // (the header too, but never over a button or a text selection)
      if (card.surface !== 'app' || !card.app?.id || e.target.closest('button, a') || String(window.getSelection?.() || '')) return;
      openIt(card);
    });
    card.tabsHead.addEventListener('click', () => { card.tabsUser = true; }); // (a card the user opened or folded stays as they left it)
    try { new MutationObserver(() => tabsCount(card)).observe(card.tabsList, { subtree: true, attributes: true, attributeFilter: ['data-state'] }); } catch { /* no observer */ }
    card.img.addEventListener('load', () => capSize(card)); // (shown at or below its own pixels, see capSize)
    host.append(el0);
    turn.cards ||= [];
    turn.cards.push(card);
    refreshCard(turn, card);
    takePending(turn, card); // ([skills] [review loop] what came before the card)
    return card;
  }
  function stateOf(turn, card) {
    // A card is working until the assistant's narration ends it (or the turn ends), however briefly no step runs between two steps.
    // [background helpers] The reply is over but a helper it started still works (main: a 'helper' event, steps the helper does): the card says so,
    // and is Done when the helper is.
    if (card.ended && !card.stopped && turn?.helpers?.size && card === turn.cards?.[turn.cards.length - 1]) return turn.approvalsWaiting?.() ? 'approval' : 'helper';
    if (card.running > 0 || !card.ended) return (turn?.approvalsWaiting?.() && card === turn.card) ? 'approval' : 'working';
    if (card.stopped) return 'stopped';
    return 'completed';
  }
  // [at once] What runs at this moment in a card: the reply's own steps still running (an 'Allowed automatically' note is not one), and each agent at work (agents-card.js; their own steps are
  // theirs, not counted again). [{ text, who }]: who is '' for the reply itself.
  function nowList(card) {
    const turn = card.turnRef;
    const out = [];
    for (const row of card.list.querySelectorAll('.step.running:not([data-helper]):not(.step-note)')) out.push({ text: trimStep(row.firstChild?.textContent || ''), who: '' });
    for (const row of turn?.agents?.card?.rows?.values?.() || []) if (row._a?.state === 'working') out.push({ text: row._a.last || tr('agents.starting'), who: row._a.desc || tr('agents.unnamed') });
    return out;
  }
  // Two things or more at once: the status line counts them, and what the reply itself runs meanwhile is a pill each under it (an agent has its
  // own row in the card's Agents list, never said twice).
  function renderMany(card, all) {
    let box = card.el.querySelector(':scope > .act-many');
    const list = all.length >= 2 ? all.filter((x) => !x.who) : [];
    if (!list.length) { if (box) box.hidden = true; return; }
    if (!box) { box = el('div', { className: 'act-many' }); box.setAttribute('role', 'list'); card.status.after(box); }
    box.hidden = false;
    const key = JSON.stringify(list);
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.replaceChildren(...list.map((x) => {
      const pill = el('span', { className: 'act-pill', title: x.text });
      pill.setAttribute('role', 'listitem');
      pill.append(el('span', { className: 'act-dot' }), el('span', { className: 'act-pill-text', textContent: x.text }));
      return pill;
    }));
  }
  function refreshCard(turn, card) {
    if (turn) card.turnRef = turn;
    const state = stateOf(turn, card);
    if (card.el.dataset.state !== state || (card.app && !card.hbApp) || (card.hadBrowser && !card.hb)) { // (a card that began on a web search or a tool and moved to a tab is watched from then on; one that moved from a page to a program, too)
      card.el.dataset.state = state;
      if (card.app) { card.hb = true; card.hbApp = true; // (a program's window: its live picture runs only while a card is on screen)
        if (state === 'working' || state === 'approval') watch(card.el); else unwatch(card.el); } // (a card on screen keeps its thumbnail refreshing; one that finished does not)
      else if (card.hadBrowser) { card.hb = true; reportVisible(true); } // a browser card draws no picture of its tab (the page itself is the preview): main is told no card wants frames
    }
    const kind = card.surface === 'browser' || card.surface === 'web' ? 'browser' : card.surface === 'app' ? (card.wordWork && !card.otherApp ? 'word' : 'terminal') : card.surface === 'tool' ? 'tool' : card.shellKind; // (Word work, alone, is a Word card) // the step being done: Browser, Computer (a command or a program), Files changed (a file written)
    if (card.icon.dataset.k !== kind) { card.icon.dataset.k = kind; card.icon.innerHTML = ICONS[kind]; card.title.textContent = tr(`card.${kind}`); }
    card.helperLabel = state === 'helper' ? helperLabelOf(turn) : '';
    const wordOnly = card.wordWork && !card.otherApp && card.surface === 'app';
    const task = card.task || (wordOnly ? '' : card.first); // (a Word card without the user's task: just its state; the step being done is in the status bar, its document in the chip, never said twice)
    const sub = task ? tr('card.sub', { state: tr(`card.state.${state}`), task }) : tr(`card.state.${state}`);
    if (card.sub.textContent !== sub) { card.sub.textContent = sub; card.el.setAttribute('aria-label', tr('card.aria', { title: card.title.textContent, sub })); }
    const steps = tr(card.count === 1 ? 'card.steps.one' : 'card.steps.other', { count: card.count });
    const sum = steps; // (the step being done is in the status bar right above: said there once, never again in the summary)
    if (card.sum.textContent !== sum) card.sum.textContent = sum;
    // The button: a browser card opens its tab once it has one; a file card opens its file.
    let label = '';
    if (card.surface === 'browser' && card.tab && !card.siteMode) label = tr(card.shot.dataset.tabClosed ? 'card.reopenPage' : 'card.openPreview');
    else if (card.surface === 'app' && card.app) label = tr(card.wordWork && !card.otherApp ? 'wordcard.show' : 'desktopcard.open'); // (a Word card says where it goes)
    // (a files card has no button: each file in it is a link that opens it)
    card.btn.hidden = !label;
    const where = card.surface === 'app' && card.app ? (card.wordWork && !card.otherApp ? tr('card.word') : card.app.name || tr('desktopcard.app')) : ''; // (the program a click goes to)
    if (label && card.btn.textContent !== label) { card.btn.textContent = label; card.btn.title = card.surface === 'browser' ? tr('card.openPreview.title') : ''; }
    if (where) card.btn.title = tr('desktopcard.show', { app: where });
    if (where && !card.shot2.hidden) { const name = tr('desktopcard.show', { app: where }); card.shot2.setAttribute('role', 'button'); card.shot2.tabIndex = 0; card.shot2.title = name; card.shot2.setAttribute('aria-label', name); } // (the picture is a real button: Enter / Space, a focus ring, a name)
    else if (card.shot2.getAttribute('role') === 'button') { for (const a of ['role', 'tabindex', 'aria-label', 'title']) card.shot2.removeAttribute(a); }
    card.head.classList.toggle('act-go', Boolean(where));
    const appLive = card.surface === 'app' && card.app && (card.app.status === 'working' || card.app.status === 'paused');
    card.resumeBtn.hidden = !(appLive && card.app.status === 'paused');
    card.stopBtn.hidden = !appLive;
    const saying = state === 'working' && Boolean(card.sayText);
    card.say.hidden = !saying;
    if (saying && card.say.textContent !== card.sayText) card.say.textContent = card.sayText;
    refreshTabs(card, state);
    cardChip(card);
    statusBar(card, state); // (the screen reader hears it, throttled; a change of state at once)
    renderMany(card, state === 'working' || state === 'helper' ? nowList(card) : []);
  }
  // ---- the tabs this turn opened or used: chips (tab-ref.js) in the order they were first touched, each marked open or closed
  // (a closed one reopens from its chip, an open one switches to it); folded by default, the head says how many.
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
    const cur = card.tab?.tabId; // the tab the preview shows: marked "closed" while the last picture stays
    const shown = cur != null && card.tabEls.get(cur)?.dataset.state === 'closed' ? '1' : '';
    if ((card.shot.dataset.tabClosed || '') !== shown) { card.shot.dataset.tabClosed = shown; if (shown) card.shot.dataset.closedLabel = tr('card.tabs.stateClosed'); if (card.surface === 'browser' && !card.btn.hidden && !card.siteMode) card.btn.textContent = tr(shown ? 'card.reopenPage' : 'card.openPreview'); } // (the button says what a click does now)
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
      wrap.append(window.tabRef.chip({ id, s: kept?.s || '' }, kept ? { t: kept.t || '', u: kept.u || '', f: kept.f || '' } : null), el('span', { className: 'act-tab-state' }));
      card.tabsList.append(wrap);
      card.touched.push(id);
      card.tabEls.set(id, wrap);
      added = true;
    }
    if (!added) return;
    card.tabsBox.hidden = false;
    if (!card.tabsUser) card.tabsBox.open = false; // folded until the user opens it (the head says how many); kept as they set it
    tabsCount(card);
  }
  // The preview is shown at or below its own pixels: its width in CSS pixels is the picture's width over the display's scale, never above CAP.
  const CAP = 340;
  function capSize(card) {
    const w = card.img.naturalWidth;
    if (!w) return;
    const shown = Math.min(CAP, Math.floor(w / Math.max(1, window.devicePixelRatio || 1)));
    card.shot.style.maxWidth = shown + 'px';
    card.el.style.setProperty('--act-w', shown + 'px'); // (the whole card is as wide as its preview: step-ui.css)
  }
  // The status bar of a Browser card: what the AI is doing right now, in the words of its steps. It replaces itself on every step; a screen
  // reader hears it (aria-live polite on the card's hidden live region) at most every 1.5 s, and a change of state (Done, Needs you) at once.
  const trimStep = (s) => String(s || '').replace(/[\s.\u2026]+$/, '');
  function siteOf(card) {
    if (card.surface === 'app') return card.app?.name || '';
    if (card.surface !== 'browser') return '';
    const t = card.tab;
    if (!t) return ''; try { return t.url ? new URL(t.url).host.replace(/^www\./, '') : ''; } catch { return ''; } }
  // What the run came to, for "Done: …": the first sentence of the reply, else the page it ended on ("Opened '<title>'"); never the last step's verb.
  function outcomeOf(card) {
    const clip = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '\u2026' : t);
    const line = String(card.outcome || '').split(/\n/).map((l) => l.replace(/^[\s>#*_`\-\d.)]+/, '').replace(/[*_`]/g, '').trim()).find(Boolean) || '';
    if (line) { const first = line.match(/^.+?[.!?](?=\s|$)/)?.[0] || line; return clip(first.replace(/[.!?\s]+$/, ''), 80); }
    const title = card.surface === 'browser' && card.navigated ? String(card.tab?.title || '').trim() : '';
    return title ? tr('card.status.opened', { title: clip(title, 70) }) : '';
  }
  // A Word card names its document in the chip under the title, so its status line says what is being done there, not the name again
  // ("Writing in Report.docx: adding a table of 3 rows" -> "Adding a table of 3 rows"; "Formatting Report.docx: “x” as Heading 1" -> "Formatting “x” as Heading 1").
  function wordStep(card, step) {
    const doc = card.word?.doc;
    if (!step || !doc || !(card.wordWork && !card.otherApp)) return step;
    if (step === `Reading ${doc}` || step === `Saving ${doc}`) return `${step.slice(0, step.indexOf(' '))} the document`; // ("Reading the document")
    if (step.startsWith(`Commenting in ${doc} `)) return `Commenting ${step.slice(`Commenting in ${doc} `.length)}`; // ("Commenting on “x”")
    if (step.endsWith(` tracked changes in ${doc}`)) return step.slice(0, -(` in ${doc}`).length); // ("Turning on tracked changes")
    const at = step.indexOf(`${doc}: `);
    if (at <= 0) return step;
    const verb = step.slice(0, at).replace(/\s+in\s*$/, '').trim();
    const rest = step.slice(at + doc.length + 2).trim();
    if (!rest) return step;
    return verb === 'Writing' ? rest.charAt(0).toUpperCase() + rest.slice(1) : `${verb} ${rest}`;
  }
  function statusFor(card, state) {
    const step = wordStep(card, trimStep(card.latest));
    if (state === 'stopped') return tr('card.status.stopped');
    if (card.surface === 'app' && card.app?.status === 'paused' && state === 'working') return tr('desktopcard.paused');
    if (state === 'completed') { const result = outcomeOf(card); return result ? tr('card.status.done', { result }) : tr('card.state.completed'); }
    if (state === 'approval') return tr('card.status.needs', { why: step ? tr('card.status.needsWhy', { step }) : tr('card.status.needsOk') });
    if (state === 'working' || state === 'helper') { const many = nowList(card).length; if (many >= 2) return tr('card.status.many', { count: many }); }
    if (state === 'helper') { const own = step && step !== card.stepAtHelper ? step.replace(/^Helper · /, '') : ''; // (the step that started the helper says nothing about what it does now)
      const what = own || card.helperLabel; return what ? tr('card.status.helper', { step: what }) : tr('card.status.helperIdle'); }
    if (!step) return tr('card.status.starting');
    const site = (card.surface === 'browser' && card.siteMode) || (card.wordWork && !card.otherApp) ? '' : siteOf(card); // (a Word card's title already says Word)
    return site && !step.toLowerCase().includes(site.toLowerCase()) ? tr('card.status.workingOn', { step, site }) : tr('card.status.working', { step });
  }
  function statusBar(card, state) {
    const text = statusFor(card, state);
    card.status.hidden = false;
    card.status.dataset.state = state;
    if (card.statusText.textContent !== text) card.statusText.textContent = text;
    linkStatus(card, text);
    if (card.liveText === text) return;
    const write = () => { card.liveTimer = 0; card.liveAt = Date.now(); card.liveText = text; card.live.textContent = text; };
    clearTimeout(card.liveTimer);
    const wait = card.liveAt + 1500 - Date.now();
    if (state !== 'working' || wait <= 0) write(); else card.liveTimer = setTimeout(() => { statusBar(card, card.el.dataset.state); }, wait);
  }
  // [background helpers] What the helpers working in the background are doing, for the card's status line: the first one's own words.
  const helperLabelOf = (turn) => { const h = turn?.helpers ? [...turn.helpers.values()][0] : null; return h ? String(h.latest || h.label || '').slice(0, 120) : ''; };
  // main's 'helper' event ({ id, state: 'working' | 'progress' | 'done' | 'failed' | 'stopped', label }): a helper Claude Code runs in the background starts,
  // makes progress or ends. The turn that started it keeps them (turn.helpers); the card of its last step shows "Helper working" after its reply is
  // over, and Done when the last helper is. Returns true when it was taken.
  function helper(turn, event) {
    if (!turn || typeof event?.id !== 'string') return false;
    const map = (turn.helpers ||= new Map());
    if (event.state === 'working') {
      map.set(event.id, { label: String(event.label || ''), latest: '' });
      const card = turn.cards?.[turn.cards.length - 1];
      if (card && card.stepAtHelper == null) card.stepAtHelper = trimStep(card.latest);
    }
    else if (event.state === 'progress') { const h = map.get(event.id); if (h) h.latest = String(event.label || ''); }
    else map.delete(event.id);
    refreshAll(turn);
    return true;
  }

  // ---- the files the AI made: each one opens from the card (its name, and "Show in folder"); a script or program is only ever shown in its folder.
  // The card's files come from main as cards of the file registry (id, name, path, canTab, canSystem): the chat names a file by that id, never by a path.
  const FILE_MAX = 5;
  const howOpen = (f) => (f.canTab ? 'tab' : f.canSystem ? 'system' : 'reveal');
  async function openFile(card, f, how, anchor) {
    const api = window.stepUI.opener || window.assistant?.files?.open;
    let got;
    try { got = await Promise.resolve(api?.(f.id, how || howOpen(f))); } catch { got = null; }
    if (got && got.ok === false && got.reason === 'blocked') { try { got = await Promise.resolve(api?.(f.id, 'reveal')); } catch { got = null; } } // (a program or script: its folder, never run)
    const msg = got && got.ok === false ? tr(got.reason === 'gone' ? 'card.file.gone' : 'card.file.failed') : '';
    let note = [...card.filesBox.querySelectorAll('.act-filenote')].find((n) => n.dataset.note === f.id);
    if (!note && msg) { note = el('span', { className: 'act-filenote' }); note.dataset.note = f.id; (anchor?.closest?.('.act-file') || card.filesBox).append(note); }
    if (note) note.textContent = msg;
  }
  function fileLink(card, f, text) {
    const b = el('button', { type: 'button', className: 'act-filelink', textContent: text || f.name, title: f.path || f.name });
    b.onclick = (e) => { e.stopPropagation(); openFile(card, f, null, b); };
    return b;
  }
  function renderFiles(card) {
    const list = card.files;
    card.filesBox.hidden = !list.length;
    card.filesBox.textContent = '';
    for (const f of list.slice(0, FILE_MAX)) {
      const row = el('div', { className: 'act-file' });
      const show = el('button', { type: 'button', className: 'act-fileshow', textContent: tr('card.showFolder') });
      show.onclick = (e) => { e.stopPropagation(); openFile(card, f, 'reveal', show); };
      row.append(fileLink(card, f), show);
      card.filesBox.append(row);
    }
    if (list.length > FILE_MAX) card.filesBox.append(el('div', { className: 'act-filemore', textContent: tr('card.files.more', { count: list.length - FILE_MAX }) }));
    for (const row of card.list.querySelectorAll('.step[data-surf="files"]')) { // (each file step has its link)
      const p = String(row._s?.input?.file_path || row._s?.input?.path || '');
      const f = WRITES.test(String(row._s?.name)) && list.find((x) => x.name && x.name === p.split(/[\\/]/).pop());
      if (!f || row.querySelector(':scope > .act-filelink')) continue;
      const b = fileLink(card, f, tr('card.openShort'));
      b.classList.add('act-steplink');
      row.append(b);
    }
    card.linkKey = '';
    statusBar(card, card.el.dataset.state);
  }
  // The status row says "Done: Created Ai/HANDOFF.md": that file name is a link.
  function linkStatus(card, text) {
    const key = text + '|' + card.files.map((f) => f.id).join();
    if (card.linkKey === key) return;
    card.linkKey = key;
    const f = card.files.find((x) => x.name && text.includes(x.name));
    if (!f) return;
    const at = text.indexOf(f.name);
    let start = at;
    while (start > 0 && /[\w./\\-]/.test(text[start - 1])) start--;
    card.statusText.replaceChildren(text.slice(0, start), fileLink(card, f, text.slice(start, at + f.name.length)), text.slice(at + f.name.length));
  }
  // main sent the files the run wrote (type 'card_files'): they join the turn's Files card (the last card when the turn is over).
  function filesMade(turn, files) {
    const card = turn?.card?.el.isConnected ? turn.card : [...(turn?.cards || [])].reverse().find((c) => c.el.isConnected);
    if (!card || !Array.isArray(files)) return false;
    for (const f of files) if (f && typeof f.id === 'string' && f.name && !card.files.some((x) => x.id === f.id)) card.files.push(f);
    if (!card.file && card.files.length) card.file = card.files[card.files.length - 1];
    renderFiles(card);
    refreshCard(turn, card);
    return true;
  }
  // The tab a Browser card works in, as a chip (live title; clicking it switches to the tab).
  // The document the AI works in, as the chip in the card's header (where a browser card has its tab): its name, and a click shows Word at the place it was changed.
  function wordChip(card) {
    const name = card.word.doc;
    if (card.tabref.dataset.sig === `word|${name}`) { card.tabref.hidden = false; return; }
    card.tabref.dataset.sig = `word|${name}`;
    card.tabref.textContent = '';
    const chip = el('button', { type: 'button', className: 'act-wordchip', title: tr('wordcard.chip.title', { doc: name }) });
    chip.innerHTML = ICONS.word;
    chip.append(el('span', { className: 'act-wordchip-name', textContent: name }));
    chip.onclick = () => openIt(card);
    card.tabref.append(chip);
    card.tabref.hidden = false;
  }
  // Any other program, the same chip: the window the AI is in (its title without the "- <App>" tail); a click brings the program forward.
  function appChip(card) {
    const app = card.app.name;
    let win = String(card.app.title || '').replace(/\s+/g, ' ').trim();
    for (const sep of [' - ', ' \u2013 ', ' \u2014 ']) if (app && win.toLowerCase().endsWith(sep + app.toLowerCase())) win = win.slice(0, win.length - sep.length - app.length).trim();
    if (!win || win.toLowerCase() === app.toLowerCase()) { card.tabref.hidden = true; card.tabref.dataset.sig = ''; return; }
    if (card.tabref.dataset.sig === `app|${win}`) { card.tabref.hidden = false; return; }
    card.tabref.dataset.sig = `app|${win}`;
    card.tabref.textContent = '';
    const chip = el('button', { type: 'button', className: 'act-wordchip', title: tr('desktopcard.show', { app: app || tr('desktopcard.app') }) });
    chip.innerHTML = ICONS.terminal;
    chip.append(el('span', { className: 'act-wordchip-name', textContent: win.slice(0, 120) }));
    chip.onclick = () => openIt(card);
    card.tabref.append(chip);
    card.tabref.hidden = false;
  }
  function cardChip(card) {
    const t = card.tab;
    if (card.surface === 'app' && card.word && card.word.doc && card.wordWork && !card.otherApp) { wordChip(card); return; } // (Word work: the document's name, which brings Word forward)
    if (card.surface === 'app' && card.app?.name && card.app.title && card.otherApp) { appChip(card); return; } // (another program: the window it is in)
    if (card.surface !== 'browser') { card.tabref.hidden = true; return; } // (working in a command, a file or a program: the tab's chip waits)
    if (card.siteMode) { card.tabref.hidden = true; card.tabref.dataset.sig = ''; return; }
    if (!t || !window.tabRef) return;
    const sig = `${t.tabId ?? ''}|${t.s || ''}|${t.tabId == null ? t.url : ''}`;
    if (card.tabref.dataset.sig === sig) { card.tabref.hidden = false; return; }
    if (t.tabId == null && !t.url) return;
    card.tabref.dataset.sig = sig;
    card.tabref.textContent = '';
    card.tabref.append(window.tabRef.chip(t.tabId != null ? { id: t.tabId, s: t.s || '' } : null, { t: t.title, u: t.url }));
    card.tabref.hidden = false;
  }
  // ---- the tabs the AI opened: hide / show them in the strip (the sidebar's own toggle, the hideAiTabs setting) and close them with Undo
  const hidingTabs = () => window.lumenHideAiTabs === true;
  function refreshTabs(card, state) {
    if (!card.hadBrowser) return;
    const n = Number(card.aiTabs) || 0;
    const on = hidingTabs();
    card.toggle.hidden = !(n > 0 || on); // (while the toggle is on it stays, so it can be turned off)
    if (!card.toggle.hidden) {
      const label = tr(on ? 'card.aiTabs.show' : 'card.aiTabs.hide');
      const text = n > 0 ? tr('card.aiTabs.count', { label, count: n }) : label;
      if (card.toggle.textContent !== text) card.toggle.textContent = text;
      card.toggle.removeAttribute('aria-pressed'); // (the label already says what a click does: Show / Hide; "pressed" on top of it read twice)
      card.toggle.title = label;
    }
    card.closeAll.hidden = !(n > 0 && card.runId != null && state !== 'working' && state !== 'approval' && state !== 'helper' && !card.closed); // (after the run: "Close them")
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
    card.note.tabIndex = -1; // (focus lands on the note: the button that was pressed goes away)
    if (!result?.closed) { card.note.textContent = tr('chat.aiTabs.none'); card.aiTabs = 0; refreshCard(null, card); card.note.focus({ preventScroll: true }); return; }
    card.aiTabs = 0;
    card.note.append(el('span', { textContent: pluralTabs('chat.aiTabs.closed', result.closed) + ' ' }));
    const undo = el('button', { type: 'button', className: 'act-undo', textContent: tr('chat.aiTabs.undo') });
    undo.onclick = async () => {
      undo.disabled = true;
      const back = await Promise.resolve(api.undoCloseAiTabs?.(result.token)).catch(() => null);
      card.note.textContent = back?.reopened ? pluralTabs('chat.aiTabs.reopened', back.reopened) : tr('chat.aiTabs.nothingReopened');
      card.closed = false;
      card.note.focus({ preventScroll: true });
    };
    card.note.append(undo);
    refreshCard(null, card);
    undo.focus({ preventScroll: true });
  }
  document.addEventListener('lumen:hide-ai-tabs', () => { for (const c of document.querySelectorAll('.act-card')) if (c._card) refreshTabs(c._card, c.dataset.state); });

  function openIt(card) {
    const api = window.assistant;
    if (card.surface === 'app' && card.app?.id) { Promise.resolve(api?.desktopOpen?.(card.app.id)).catch(() => {}); return; }
    if (card.surface === 'browser' && card.tab) { Promise.resolve(api?.openPreview?.({ tabId: card.tab.tabId ?? null, url: card.tab.url || '' })).catch(() => {}); return; }
    if (card.file && card.surface !== 'browser') { const f = card.file; Promise.resolve(api?.files?.open?.(f.id, f.canTab ? 'tab' : f.canSystem ? 'system' : 'reveal')).catch(() => {}); }
  }
  function setThumb(card, src) {
    if (!src) return;
    card.siteMode = false;
    card.shot.dataset.mode = 'frame';
    if (card.img.getAttribute('src') !== src) swapFrame(card, src);
    if (card.shot.hidden) { card.shot.hidden = false; card.img.alt = tr('card.thumb.alt'); }
  }
  // A new frame is decoded off to the side and swapped in when it is ready, so a live stream (about 12 a second) never makes the card or the chat
  // wait on a decode; frames that arrive while one decodes are dropped but the newest. The first picture (nothing shown yet) goes in at once.
  function swapFrame(card, src) {
    if (!card.img.getAttribute('src') || typeof Image !== 'function') { card.img.src = src; return; }
    card.nextSrc = src;
    if (card.decoding) return;
    const next = () => {
      const want = card.nextSrc;
      card.nextSrc = null;
      if (!want) { card.decoding = false; return; }
      card.decoding = true;
      const g = card.frameGen || 0;
      const pic = new Image();
      pic.src = want;
      Promise.resolve(pic.decode?.()).catch(() => {}).then(() => {
        if ((card.frameGen || 0) === g && card.img.getAttribute('src') !== want) card.img.src = want;
        next();
      });
    };
    next();
  }
  const dropFrames = (card) => { card.frameGen = (card.frameGen || 0) + 1; card.nextSrc = null; };
  // The page preview of a Word card (when Word's own window cannot be shown): the paragraphs around the last change, drawn as a small page; text only.
  function setPage(card, page) {
    const box = card.page;
    if (!box) return;
    if (!page || !Array.isArray(page.lines) || !page.lines.length) { box.hidden = true; box.textContent = ''; return; }
    const sig = JSON.stringify(page.lines);
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.textContent = '';
      let mark = null;
      for (const line of page.lines.slice(0, 16)) {
        const kind = /^(h[123]|p|li|tr)$/.test(String(line.k)) ? line.k : 'p';
        const row = el('div', { className: `act-pg act-pg-${kind}${line.hl ? ' hl' : ''}` });
        row.textContent = String(line.t ?? '').slice(0, 240);
        box.append(row);
        if (line.hl && !mark) mark = row;
      }
      box.setAttribute('role', 'img');
      box.setAttribute('aria-label', tr('wordcard.pageAlt', { doc: String(page.doc || card.word?.doc || '') }));
      if (mark) box.scrollTop = Math.max(0, mark.offsetTop - 36);
    }
    box.hidden = false;
    card.img2.hidden = true;
    card.shot2.hidden = false;
  }
  function setShot2(card, src) {
    if (!src) return;
    if (card.page) { card.page.hidden = true; card.img2.hidden = false; }
    if (card.img2.getAttribute('src') !== src) card.img2.src = src;
    card.shot2.hidden = false;
    if (!card.img2.alt) card.img2.alt = tr('card.thumb.alt2');
  }
  // The AI moved to another tab: the old picture must not stay under the new tab's name. A blank (the picture comes in a moment).
  function setPending(card) {
    card.siteMode = false;
    if (card.shot.hidden) return;
    card.shot.dataset.mode = 'pending';
    dropFrames(card);
    card.img.removeAttribute('src');
  }
  // The tab only gave blank (one-colour) frames, e.g. a viewer drawn on a canvas in a hidden view: never a solid rectangle. The last good picture
  // of the same tab stays; otherwise "Reading <name>" with the tab's icon, while the tab's chip stays.
  function setBlank(card, event) {
    card.siteMode = false;
    if (card.shot.dataset.mode === 'frame' && card.img.getAttribute('src') && card.goodTab === (event.tabId ?? null)) return;
    card.shot.hidden = false;
    card.shot.dataset.mode = 'site';
    dropFrames(card);
    card.img.removeAttribute('src');
    let name = event.title || '';
    if (!name) { try { name = new URL(event.url).host; } catch { /* none */ } }
    card.siteName.textContent = tr('card.site.reading', { site: name });
    const icon = typeof event.favicon === 'string' ? event.favicon : '';
    card.siteIco.hidden = !icon;
    if (icon) card.siteIco.src = icon; else card.siteIco.removeAttribute('src');
    card.shot.style.maxWidth = '';
  }
  // The tab the AI works in: "Reading <name>" with the tab's icon (a click goes to the tab), never a picture of it. The name follows the tab.
  function setTabRow(card, event) {
    card.siteMode = false;
    let name = event.title || '';
    if (!name) { try { name = new URL(event.url).host; } catch { /* none */ } }
    if (!name) return; // (a tab with no name yet: the last one stays until it has one)
    card.shot.hidden = false;
    card.shot.dataset.mode = 'site';
    dropFrames(card);
    card.img.removeAttribute('src');
    card.siteName.textContent = tr('card.site.reading', { site: name });
    const icon = typeof event.favicon === 'string' ? event.favicon : '';
    if (icon || card.shownTab !== event.tabId) { card.siteIco.hidden = !icon; if (icon) card.siteIco.src = icon; else card.siteIco.removeAttribute('src'); } // (a frame without the icon keeps the tab's icon)
    card.shownTab = event.tabId;
    card.shot.style.maxWidth = '';
  }
  // A step that reads an address with no tab (read_urls): "Reading <site>" with its icon, no picture of another tab.
  function setSite(card, event) {
    card.siteMode = true;
    card.shot.hidden = false;
    card.shot.dataset.mode = 'site';
    dropFrames(card);
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
  // The surface a step works on: 'browser', 'shell' (commands and files), 'app' (another program on the PC), or null (no card).
  const bareName = (n) => String(n || '').replace(/^mcp__lumen__/, '');
  function surfaceFor(name, input) {
    if (bareName(name) === 'desktop' || bareName(name) === 'word') return 'app'; // (the word tool works in Word: the same card, with the document as its preview)
    return window.stepLabels.surfaceOf(name, input);
  }
  const isNote = (name) => bareName(name) === 'auto_allowed'; // "Allowed automatically: …": a small row in the card, never a line of its own
  const WRITES = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
  // Marks a row with the surface it was done on (shown before the step: Browser, Computer, Files).
  function markRow(row, surface, name) {
    const k = surface === 'browser' || surface === 'web' ? 'browser' : surface === 'app' ? 'terminal' : WRITES.test(String(name)) ? 'files' : 'terminal';
    row.dataset.surf = k;
    row.dataset.surfLabel = tr(k === 'files' ? 'card.files.short' : `card.${k}`);
    row.title = `${row.firstChild?.textContent || ''} (${row.dataset.surfLabel})`; // the icon's word, as the tooltip
  }
  // The card moves to the surface of the step now being done (its icon, title, preview and status follow).
  function setSurface(card, surface, name) {
    if (surface === 'browser') card.hadBrowser = true;
    if (/^(mcp__lumen__)?(navigate|open_tab|go_back|go_forward|reload|switch_tab)$/.test(String(name || ''))) card.navigated = true;
    if (surface === 'shell') card.shellKind = WRITES.test(String(name)) ? 'files' : 'terminal';
    if (surface === 'app') { if (String(name) === 'word') card.wordWork = true; else if (String(name) === 'desktop') card.otherApp = true; }
    if (card.surface !== surface) { card.surface = surface; card.el.dataset.surface = surface; }
  }
  // A row for an approval that was answered for you: small, inside the card (or, when no card is there yet, in its place until one is).
  function addNote(turn, row, opts) {
    row.classList.add('step-note');
    if (turn.card?.el.isConnected) { turn.card.list.append(row); return; }
    (turn.noteRows ||= []).push(row);
    opts.append(row);
  }
  // The plain step rows a turn drew before its card existed move into the card (each entry as it is, groups included), counted as its steps.
  function adoptPlain(turn, card) {
    for (const plain of turn.allPlain || []) {
      for (const e of plain.entries) {
        card.list.append(e.el);
        card.entries.push(e);
        for (const m of e.members) { card.count++; if (m.classList.contains('running')) card.running++; m._card = card; }
      }
      plain.entries.length = 0;
    }
    turn.allPlain = null;
    turn.plain = null;
  }
  function add(turn, event, opts) {
    init(opts.messages);
    const label = opts.fallback ? (labelFor(event) || opts.fallback) : labelFor(event);
    const running = Boolean(event.id);
    const data = { name: event.name, input: event.input && typeof event.input === 'object' ? event.input : null, label, baseLabel: label, hasOutputSlot: running };
    const row = makeRow(label, running, data);
    const own = isNote(event.name) ? null : surfaceFor(event.name, data.input);
    // The first step of a turn starts its card whatever it is (a web search, a page read, any tool); a step with no surface of its own after that joins the card.
    const surface = own || (isNote(event.name) || liveCard(turn) ? null : window.stepLabels.weakSurfaceOf(event.name));
    const info = SL().groupInfo(event.name, data.input, label);
    window.tabRef?.forStep(row, event.name, data.input, null); // [tab chips] a step that names a tab
    const tail = (e) => !turn.working || e.nextElementSibling === turn.working || !e.nextElementSibling;
    if (isNote(event.name)) {
      addNote(turn, row, opts);
    } else if (surface) {
      let card = liveCard(turn);
      if (!card) {
        card = makeCard(turn, surface, { append: (n) => opts.append(n) });
        turn.card = card;
        for (const n of turn.noteRows || []) card.list.append(n); // (approvals that came before the first step)
        turn.noteRows = null;
        adoptPlain(turn, card); // (steps of this turn that came before the card: they belong in it)
      }
      if (card.ended && !opts.late) { card.ended = false; card.stopped = false; } // (a late step, a helper's, does not undo the Done of the reply that started it) // (a step after the card said Done: it works again, and says Done at the turn's real end)
      setSurface(card, surface, event.name);
      if (surface === 'browser' && !card.browserInit) { card.browserInit = true; card.task = SL().taskName(opts.task || ''); if (turn.lastThumb && !card.tab) { card.tab = turn.lastThumb.tab; setTabRow(card, turn.lastThumb.tab); } }
      markRow(row, surface, event.name);
      if (opts.runId != null && card.runId == null) card.runId = opts.runId;
      if (!card.first) card.first = label;
      card.count++;
      if (running) card.running++;
      card.latest = label;
      place(card, row, info);
      touchTabs(card, window.tabMarker ? window.tabMarker.stepTabs(event.name, data.input) : []);
      refreshCard(turn, card);
      row._card = card;
    } else if (liveCard(turn)) {
      // A step that is on no surface of its own (a web search, a tool): in the turn's card, in order, not in a row of its own under it.
      const card = turn.card;
      if (card.ended && !opts.late) { card.ended = false; card.stopped = false; } // (a late step, a helper's, does not undo the Done of the reply that started it)
      card.count++;
      if (running) card.running++;
      card.latest = label;
      place(card, row, info);
      refreshCard(turn, card);
      row._card = card;
    } else {
      const plain = turn.plain || (turn.plain = { entries: [], host: { append: (n) => opts.append(n) } });
      if (!(turn.allPlain ||= []).includes(plain)) turn.allPlain.push(plain);
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
    groupRefresh(row); // (the group this step is in: done once every member is, with its total time)
    return plain;
  }
  // The turn ended: steps still running were stopped.
  function finalize(turn, event) {
    for (const card of turn?.cards || []) {
      if (card.hadBrowser && Number.isFinite(event?.aiTabCount)) card.aiTabs = event.aiTabCount; // (the run is over: the tab it worked in counts now)
      for (const row of card.list.querySelectorAll('.step.stopped')) { card.stopped = true; row._card && (row._card.running = Math.max(0, row._card.running - 1)); }
      card.running = 0;
      if (typeof event?.reply === 'string' && event.reply.trim()) card.outcome = event.reply;
      card.ended = true;
      card.sayText = '';
      refreshCard(turn, card);
    }
  }
  // The assistant said something before a step: it is that step's live line in the card (not a bubble of its own). True when a card took it.
  function narrate(turn, text) {
    const card = turn?.card;
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    if (!card || !card.el.isConnected || !line) return false;
    card.sayText = line.length > 240 ? line.slice(0, 239) + '…' : line;
    refreshCard(turn, card);
    return true;
  }
  // Another program on the PC (src/desktop): the same card, with the program's window as its preview, its state in the status bar.
  const IMAGE = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
  function desktop(turn, event, opts) {
    if (!event || typeof event.id !== 'string' || !turn) return false;
    let card = turn.card;
    if (!card || !card.el.isConnected) {
      card = makeCard(turn, 'app', { append: (n) => opts.append(n) });
      turn.card = card;
      for (const n of turn.noteRows || []) card.list.append(n);
      turn.noteRows = null;
    }
    if (event.frame && card.surface === 'app' && card.app?.id === event.id && typeof event.thumbnail === 'string' && IMAGE.test(event.thumbnail)) { setShot2(card, event.thumbnail); return true; } // a live picture: only the picture changes
    setSurface(card, 'app', event.word === true ? 'word' : 'desktop');
    card.app = { id: event.id, name: String(event.app || ''), title: String(event.title || '').slice(0, 200), status: event.status || 'working' };
    if (event.word === true) card.word = { doc: String(event.doc || '').slice(0, 200) };
    if (event.status === 'working' && event.task) card.latest = String(event.task);
    if (event.word === true && event.page && Array.isArray(event.page.lines) && !(typeof event.thumbnail === 'string' && IMAGE.test(event.thumbnail))) { card.img2.removeAttribute('src'); setPage(card, event.page); } // (Word's window cannot be shown: the page around the change)
    else if (typeof event.thumbnail === 'string' && IMAGE.test(event.thumbnail)) { card.img2.alt = tr('desktopcard.thumbAlt', { app: event.word === true ? (card.word?.doc || card.app.name) : card.app.name }); setShot2(card, event.thumbnail); }
    else if (event.blocked) { card.img2.removeAttribute('src'); card.shot2.hidden = true; } // the window turned into something the AI may not use: its picture goes, the card shows no preview
    refreshCard(turn, card);
    return true;
  }
  function refreshAll(turn) { for (const card of turn?.cards || []) refreshCard(turn, card); }
  // [background helpers] Claude Code began a turn of its own on a helper's result while the reply before it still shows its card (its helpers
  // work on, or it is simply the newest card in the chat): the new turn's steps go on in that card instead of a second card under it, and the
  // two turns share the helpers, so the card says Working until the last of them is done. A card that something newer was drawn after is left.
  // The card a turn's steps go in now. A carried turn's card can be drawn again under it (main re-sends the chat when the follow-up starts, and the
  // reply before is drawn from what was saved): the newest card in the chat is that card, and the turn goes on in it.
  function liveCard(turn) {
    if (turn.card?.el.isConnected) return turn.card;
    if (!turn.carried) return null;
    const root = turn.working?.parentElement || document.getElementById('messages');
    const all = root ? root.querySelectorAll(':scope > .act-card') : [];
    const last = all[all.length - 1];
    if (!last?._card) return null;
    turn.card = last._card;
    turn.cards = [last._card];
    return last._card;
  }
  function carryOn(prev, turn) {
    const card = prev?.cards?.[prev.cards.length - 1];
    if (!card || !turn || turn.card || !card.el.isConnected) return false;
    const cards = card.el.parentElement ? [...card.el.parentElement.querySelectorAll(':scope > .act-card, :scope > .helper-card, :scope > .approval')] : [];
    if (cards[cards.length - 1] !== card.el) return false;
    turn.card = card;
    turn.cards = [card];
    turn.carried = true;
    turn.helpers = (prev.helpers ||= new Map());
    turn.agents = (prev.agents ||= { card: null }); // ([agents card] one card for both turns' agents too)
    return true;
  }

  // ---- [skills] [review loop] Which skill the reply works by (a chip under the card's title), and the review loop's rounds (a score track).
  // A turn with no card yet keeps them until its card is made (pendingOf / takePending).
  function cardOf(turn) { return liveCard(turn) || turn?.cards?.[turn.cards.length - 1] || null; }
  function paintSkills(card) {
    const names = card.skills || [];
    let chip = card.el.querySelector('.act-skill');
    if (!names.length) { if (chip) chip.hidden = true; return; }
    if (!chip) { chip = el('div', { className: 'act-skill' }); card.el.querySelector('.act-titles').append(chip); }
    chip.hidden = false;
    chip.textContent = tr(names.length === 1 ? 'card.skill.one' : 'card.skill.other', { name: names.join(', ') });
  }
  function skill(turn, event) {
    const title = String(event?.title || event?.name || '').slice(0, 60);
    if (!turn || !title) return false;
    const card = cardOf(turn);
    if (!card) { ((turn.pending ||= {}).skills ||= []).push(title); return true; }
    card.skills ||= [];
    if (!card.skills.includes(title)) card.skills.push(title);
    paintSkills(card);
    return true;
  }
  function paintReview(card) {
    const r = card.review;
    if (!r || !r.rounds.length) return;
    let box = card.el.querySelector(':scope > .act-review');
    if (!box) {
      box = el('div', { className: 'act-review' });
      box.setAttribute('role', 'group');
      const after = card.el.querySelector(':scope > .act-many:not([hidden])') || card.status;
      after.after(box);
    }
    const last = r.rounds[r.rounds.length - 1];
    box.dataset.met = last.met ? '1' : '';
    const head = el('div', { className: 'rv-head' }, el('span', { className: 'rv-title', textContent: tr('card.review.title') }), el('span', { className: 'rv-bar', textContent: tr('card.review.bar', { bar: r.bar }) }));
    if (r.title) head.append(el('span', { className: 'rv-what', textContent: r.title }));
    const track = el('ol', { className: 'rv-track' });
    for (const x of r.rounds) {
      const li = el('li', { className: 'rv-round' + (x.met ? ' met' : '') });
      li.title = tr('card.review.roundTitle', { round: x.round, score: x.score, bar: r.bar });
      li.append(el('span', { className: 'rv-n', textContent: tr('card.review.round', { round: x.round }) }), el('span', { className: 'rv-score', textContent: String(x.score) }));
      track.append(li);
    }
    const kids = [head, track];
    if (!last.met && last.fixes?.length) {
      const fixes = el('ul', { className: 'rv-fixes' });
      for (const f of last.fixes.slice(0, 3)) fixes.append(el('li', { textContent: f }));
      kids.push(el('div', { className: 'rv-fixes-head', textContent: tr('card.review.fixes') }), fixes);
    }
    box.replaceChildren(...kids);
    box.setAttribute('aria-label', last.met ? tr('card.review.ariaMet', { score: last.score, bar: r.bar, rounds: r.rounds.length }) : tr('card.review.aria', { score: last.score, bar: r.bar, round: last.round }));
  }
  function review(turn, event) {
    if (!turn || !Number.isFinite(event?.score) || !Number.isFinite(event?.bar)) return false;
    const card = cardOf(turn);
    if (!card) { ((turn.pending ||= {}).reviews ||= []).push(event); return true; }
    addRound(card, event);
    return true;
  }
  function addRound(card, event) {
    const r = (card.review ||= { bar: event.bar, title: '', rounds: [] });
    r.bar = event.bar;
    if (event.title) r.title = String(event.title).slice(0, 80);
    const round = { round: Number(event.round) || r.rounds.length + 1, score: event.score, met: event.met === true || event.score >= event.bar, fixes: Array.isArray(event.fixes) ? event.fixes.map(String).slice(0, 5) : [] };
    const at = r.rounds.findIndex((x) => x.round === round.round);
    if (at >= 0) r.rounds[at] = round; else r.rounds.push(round);
    r.rounds.sort((a, b) => a.round - b.round);
    paintReview(card);
  }
  // A card just made takes the skill and the rounds its turn heard before it existed.
  function takePending(turn, card) {
    const p = turn?.pending;
    if (!p) return;
    turn.pending = null;
    for (const t of p.skills || []) { card.skills ||= []; if (!card.skills.includes(t)) card.skills.push(t); }
    if (p.skills?.length) paintSkills(card);
    for (const e of p.reviews || []) addRound(card, e);
  }
  // [background helpers] Claude Code began a turn of its own on a helper's result while the reply before it still shows its card (its helpers
  // work on, or it is simply the newest card in the chat): the new turn's steps go on in that card instead of a second card under it, and the
  // two turns share the helpers, so the card says Working until the last of them is done. A card that something newer was drawn after is left.
  // The card a turn's steps go in now. A carried turn's card can be drawn again under it (main re-sends the chat when the follow-up starts, and the
  // reply before is drawn from what was saved): the newest card in the chat is that card, and the turn goes on in it.
  function liveCard(turn) {
    if (turn.card?.el.isConnected) return turn.card;
    if (!turn.carried) return null;
    const root = turn.working?.parentElement || document.getElementById('messages');
    const all = root ? root.querySelectorAll(':scope > .act-card') : [];
    const last = all[all.length - 1];
    if (!last?._card) return null;
    turn.card = last._card;
    turn.cards = [last._card];
    return last._card;
  }
  function carryOn(prev, turn) {
    const card = prev?.cards?.[prev.cards.length - 1];
    if (!card || !turn || turn.card || !card.el.isConnected) return false;
    const cards = card.el.parentElement ? [...card.el.parentElement.querySelectorAll(':scope > .act-card, :scope > .helper-card, :scope > .approval')] : [];
    if (cards[cards.length - 1] !== card.el) return false;
    turn.card = card;
    turn.cards = [card];
    turn.carried = true;
    turn.helpers = (prev.helpers ||= new Map());
    turn.agents = (prev.agents ||= { card: null }); // ([agents card] one card for both turns' agents too)
    return true;
  }

  // A thumbnail of the tab the AI works in: { data (base64 jpeg), url, title, tabId }.
  function thumb(turn, event) {
    const tab = { tabId: event.tabId ?? null, url: event.url || '', title: event.title || '' };
    const kind = event.kind || 'frame'; // 'frame' (a picture), 'pending' (the tab being acted on changed), 'site' (an address read with no tab)
    const src = kind === 'frame' && event.data ? `data:image/jpeg;base64,${event.data}` : '';
    turn.lastThumb = kind === 'frame' ? { src, tab } : null;
    const card = turn.card && turn.card.hadBrowser ? turn.card : [...(turn.cards || [])].reverse().find((c) => c.hadBrowser);
    if (!card) return;
    card.tab = tab;
    if (Number.isInteger(event.tabId)) touchTabs(card, [event.tabId], { [event.tabId]: { t: tab.title, u: tab.url, f: typeof event.favicon === 'string' ? event.favicon : '' } });
    if (Number.isFinite(event.aiTabs)) card.aiTabs = event.aiTabs;
    tabsCount(card);
    if (kind === 'site') setSite(card, event); else setTabRow(card, event); // (no frame of the tab: a still picture beside the live page read as a frozen copy of it)
    refreshCard(turn, card);
  }
  // A file the AI made: the card offers it (Open file / Show in folder) and, for a picture, shows it as its preview.
  function fileMade(turn, file) {
    const card = turn?.card;
    if (!card || !file) return;
    card.file = file;
    refreshCard(turn, card);
    if (file.kind === 'image' && file.trusted && file.previewable) Promise.resolve(window.assistant?.files?.preview?.(file.id)).then((got) => { if (got?.dataUrl) setShot2(card, got.dataUrl); }).catch(() => {});
  }

  // ---- a reopened chat: the steps of one saved reply as nodes (cards for the browser and the shell, a folded group for the rest)
  function restoreNodes(item) {
    const tools = Array.isArray(item.tools) ? item.tools : [];
    const out = [];
    const turn = { cards: [], card: null, plain: null, working: null };
    const host = { append: (n) => out.push(n) };
    let legacy = null;
    const flushLegacy = () => { /* one folded group for all the steps that are on no surface (kept: a later step does not start another) */ };
    const early = []; // steps on no surface that came before the card's first step
    const hasCard = tools.some((x) => x && x.name && !isNote(String(x.name))); // (any step starts the card, as live)
    for (const tool of tools) {
      const name = String(tool.name || '');
      let input = tool.input && typeof tool.input === 'object' ? tool.input : null;
      if (!input && /^(Bash|PowerShell)$/.test(name) && /^Running /.test(tool.label || '')) input = { command: String(tool.label).replace(/^Running /, '') };
      const label = (window.stepLabels && SL().label(name, input || {})) || tool.label || name;
      const surface = !name || isNote(name) ? null : surfaceFor(name, input) || (turn.card ? null : window.stepLabels.weakSurfaceOf(name));
      const data = { name, input, label, baseLabel: label, done: true };
      const row = makeRow(label, false, data);
      if (tool.ok === false) { row.className = 'step failed restored'; } else row.className = 'step done restored';
      const info = SL().groupInfo(name, input, label);
      window.tabRef?.forStep(row, name, input, item.tabs, Number.isInteger(tool.tab) ? tool.tab : null);
      if (name && isNote(name)) {
        row.classList.add('step-note');
        if (turn.card) turn.card.list.append(row); else (turn.noteRows ||= []).push(row);
      } else if (surface) {
        flushLegacy();
        let card = turn.card;
        if (!card) {
          card = makeCard(turn, surface, host);
          turn.card = card;
          if (surface === 'browser') { unwatch(card.el); card.browserInit = true; }
          for (const n of turn.noteRows || []) card.list.append(n);
          turn.noteRows = null;
          for (const e of early) { card.count++; e.row._card = card; place(card, e.row, e.info); }
          early.length = 0;
        }
        setSurface(card, surface, name);
        markRow(row, surface, name);
        if (!card.first) card.first = label;
        card.count++;
        card.latest = label;
        place(card, row, info);
        row._card = card;
      } else if (hasCard && turn.card) { // (a step on no surface, after the card's first step: in the card, in order)
        turn.card.count++;
        turn.card.latest = label;
        place(turn.card, row, info);
        row._card = turn.card;
      } else if (hasCard) {
        early.push({ row, info });
      } else {
        if (!legacy) {
          const group = el('details', { className: 'step-group restored' });
          const summary = el('summary', { className: 'step done restored' });
          summary.innerHTML = '<span class="step-detail"></span>';
          group.append(summary, el('div', { className: 'step-items' }));
          legacy = { group, summary, n: 0, items: group.lastChild, entries: [] };
          out.push(group);
        }
        legacy.n++;
        place({ entries: legacy.entries, list: legacy.items }, row, info);
        legacy.summary.firstChild.textContent = tr(legacy.n === 1 ? 'chat.usedActions.one' : 'chat.usedActions.other', { count: legacy.n });
      }
    }
    for (const n of turn.noteRows || []) out.push(n); // (approvals of a turn with no step on a surface)
    for (const card of turn.cards) { card.ended = true; if (card.firstSurface === 'browser') card.task = item.task || ''; }
    const t = item.thumb;
    if (t && (Number.isInteger(t.tabId) || t.url)) { // (a chat saved before pictures were dropped still has t.data: unused)
      const last = [...turn.cards].reverse().find((c) => c.hadBrowser);
      if (last) { last.tab = { tabId: Number.isInteger(t.tabId) ? t.tabId : null, s: t.s || '', url: t.url || '', title: t.title || '' }; const kept = item.tabs && Number.isInteger(t.tabId) ? (item.tabs[t.tabId] || item.tabs[String(t.tabId)]) : null; // (a saved frame with no name: the tab's name as the chat kept it)
        setTabRow(last, { tabId: last.tab.tabId, title: last.tab.title || kept?.t || '', url: last.tab.url || kept?.u || '', favicon: kept?.f || '' }); }
    }
    const touchedIds = Array.isArray(item.touched) ? item.touched.filter(Number.isInteger) : [];
    const lastBrowser = [...turn.cards].reverse().find((c) => c.hadBrowser);
    if (lastBrowser && touchedIds.length) { touchTabs(lastBrowser, touchedIds, item.tabs || null); tabsCount(lastBrowser); }
    if (lastBrowser && !lastBrowser.tab && touchedIds.length && item.tabs) { // (no saved frame: the name row is the last tab the turn worked in, as the chat kept it)
      const id = touchedIds[touchedIds.length - 1];
      const kept = item.tabs[id] || item.tabs[String(id)];
      if (kept) { lastBrowser.tab = { tabId: id, s: kept.s || '', url: kept.u || '', title: kept.t || '' }; setTabRow(lastBrowser, { tabId: id, title: kept.t || '', url: kept.u || '', favicon: kept.f || '' }); tabsCount(lastBrowser); refreshCard(turn, lastBrowser); }
    }
    const written = Array.isArray(item.written) ? item.written.filter((x) => x && typeof x.id === 'string' && x.name) : []; // (main made these rows from the paths the reply kept: same links as live)
    const filesCard = turn.cards[turn.cards.length - 1] || null; // (the card of the last step, as live: filesMade)
    if (filesCard && written.length) { filesCard.files = written.slice(0, 12); filesCard.file = filesCard.files[filesCard.files.length - 1]; renderFiles(filesCard); }
    for (const card of turn.cards) { card.running = 0; refreshCard(turn, card); }
    const lastCard = turn.cards[turn.cards.length - 1] || null; // ([skills] [review loop] as the reply left them)
    if (lastCard && Array.isArray(item.skills) && item.skills.length) { lastCard.skills = item.skills.map((s) => String(s?.title || s?.name || s)).filter(Boolean).slice(0, 4); paintSkills(lastCard); }
    if (lastCard && item.review && Array.isArray(item.review.rounds)) for (const x of item.review.rounds) addRound(lastCard, { ...x, bar: item.review.bar, title: item.review.title });
    return out;
  }

  // A row that is no step (the AI's thinking): in the card's step list, in order, once the turn has a card; until then loose in the chat, and it moves
  // into the card with the notes when the first step makes it. Returns true when it is in the card.
  function bare(turn, node) {
    const card = turn?.card;
    if (card?.el.isConnected) { card.list.append(node); card.entries.push({ info: null, members: [], el: node }); return true; }
    if (turn) (turn.noteRows ||= []).push(node);
    return false;
  }
  window.stepUI = { helper, bare, filesMade, opener: null, init, makeRow, setLabel, add, update, done, endCard, finalize, refreshAll, thumb, fileMade, narrate, desktop, restoreNodes, toggle, labelFor, carryOn, liveCard, skill, review };
})();
