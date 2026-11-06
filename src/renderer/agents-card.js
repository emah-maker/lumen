// [agents card] The subagents a reply started (Claude Code's Agent tool, in the background or ones the reply waits on): one card under that reply,
// a row per agent with its name, a live clock, how many tool calls it made, what it is doing now, and its summary once it is done. main sends
// { type: 'agent', id, desc, background, state: 'working' | 'done' | 'failed' | 'stopped', startedAt, endedAt, tools, tokens, last, summary }
// (ai/cc-helpers.js snapshot) for each change, long after the reply ended too; a reopened chat draws the card from the saved reply (item.agents).
(() => {
  const tr = (k, v) => window.t(k, v);
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.2c2.4-.3 4.4 1.2 5 4.3"/></svg>';
  const ENDED = new Set(['done', 'failed', 'stopped']);
  const live = new Set(); // the agents heard working in this window: a chat drawn again from what was saved shows them working, not stopped
  const endedHere = new Map(); // [review loop] id -> how an agent heard here ended: a chat drawn again from a save made while it worked shows it so, not stopped

  const clock = (ms) => (window.stepTime ? window.stepTime.format(Math.max(0, ms)) : `${Math.round(Math.max(0, ms) / 1000)} s`) || tr('agents.justNow');

  function makeCard() {
    const card = el('section', { className: 'agents-card' });
    card.setAttribute('role', 'group');
    const icon = el('span', { className: 'ag-icon' });
    icon.innerHTML = ICON;
    const sub = el('div', { className: 'ag-sub' });
    const head = el('div', { className: 'ag-head' }, icon, el('div', { className: 'ag-titles' }, el('div', { className: 'ag-title', textContent: tr('agents.title') }), sub));
    const list = el('ul', { className: 'ag-list' });
    card.append(head, list);
    const out = { el: card, sub, list, rows: new Map() };
    card._ag = out;
    return out;
  }

  function makeRow(a) {
    const row = el('li', { className: 'ag-row' });
    const name = el('span', { className: 'ag-name' });
    const bg = el('span', { className: 'ag-bg', textContent: tr('agents.background') });
    const now = el('div', { className: 'ag-now' });
    const time = el('span', { className: 'ag-time' });
    const tools = el('span', { className: 'ag-tools' });
    const score = el('span', { className: 'ag-score', hidden: true }); // [review loop] a reviewer's score, once it answered
    const main = el('div', { className: 'ag-main' }, el('div', { className: 'ag-line' }, name, bg), now);
    row.append(el('span', { className: 'ag-dot', ariaHidden: 'true' }), main, el('div', { className: 'ag-meta' }, el('span', { className: 'ag-when' }, score, time), tools)); // (a score on the clock's line: a reviewer that answers keeps its row's height)
    row._p = { name, bg, now, time, tools, score };
    // A finished agent's summary is cut to two lines; the row opens to show all of it.
    row.addEventListener('click', () => { if (row.dataset.state !== 'working' && row._a?.summary) row.classList.toggle('open'); });
    return row;
  }

  function paintRow(row, a) {
    row._a = a;
    const p = row._p;
    row.dataset.state = a.state;
    p.name.textContent = a.desc || tr('agents.unnamed');
    p.name.title = p.name.textContent; // (one line, cut with an ellipsis: all of it in the tooltip)
    p.bg.hidden = !a.background;
    const ended = ENDED.has(a.state);
    const text = ended ? (a.summary || tr(`agents.state.${a.state}`)) : (a.last || tr('agents.starting'));
    if (p.now.textContent !== text) { p.now.textContent = text; p.now.title = text; }
    row.tabIndex = ended && a.summary ? 0 : -1;
    p.tools.textContent = a.tools ? tr(a.tools === 1 ? 'agents.tools.one' : 'agents.tools.other', { count: a.tools }) : '';
    const RT = window.reviewTrack;
    const score = a.state === 'done' && RT?.roundOfAgent(a.desc) ? RT.scoreIn(a.summary) : null;
    p.score.hidden = score === null;
    p.score.textContent = score === null ? '' : tr('agents.score', { score });
    paintTime(row);
    row.setAttribute('aria-label', `${p.name.textContent}: ${ended ? tr(`agents.state.${a.state}`) : tr('agents.state.working')}${score === null ? '' : `, ${tr('agents.score', { score })}`}. ${text}`);
  }
  function paintTime(row) {
    const a = row._a;
    if (!a || !a.startedAt) { row._p.time.textContent = ''; return; }
    const ms = (ENDED.has(a.state) ? a.endedAt || Date.now() : Date.now()) - a.startedAt;
    row._p.time.textContent = clock(ms);
  }

  function paintHead(card) {
    const n = { working: 0, done: 0, failed: 0, stopped: 0 };
    for (const row of card.rows.values()) n[row._a.state] = (n[row._a.state] || 0) + 1;
    const parts = ['working', 'done', 'failed', 'stopped'].filter((k) => n[k]).map((k) => tr(`agents.count.${k}`, { count: n[k] }));
    card.sub.textContent = parts.join(' · ');
    card.el.dataset.state = n.working ? 'working' : n.failed ? 'failed' : 'done';
    card.el.classList.toggle('card-steady', Boolean(n.working)); // [steady] a line each while any agent works (step-ui.css "card-steady"); inside an activity card, that card's state says it too
    card.el.setAttribute('aria-label', `${tr('agents.title')}: ${card.sub.textContent}`);
    paintTabs(card);
  }

  // [card tabs] A busy run (more than a few agents, or two items or more: card-items.js) shows its agents by item: a main tab with one row per
  // item (its state, its latest score, how long it has run) and a tab per item with only that item's agents and its rounds. The tab picked stays
  // picked for the card, drawn again too; while the run works, the panel keeps the height of its tallest tab, so a switch moves nothing under it.
  const picked = new Map(); // first agent's id -> the tab picked on that card
  let panels = 0;
  function paintTabs(card) {
    const CI = window.cardItems;
    if (!CI) return;
    const agents = [...card.rows.values()].map((r) => r._a);
    const on = CI.tabbed(agents);
    card.el.classList.toggle('ag-tabbed', on);
    if (!on) {
      card.el.closest('.act-card')?.classList.remove('ag-rated');
      if (card.strip) { card.strip.hidden = true; card.items.hidden = true; card.rv.hidden = true; card.panel.style.minHeight = ''; for (const row of card.rows.values()) row.hidden = false; }
      return;
    }
    if (!card.strip) buildTabs(card);
    card.strip.hidden = false;
    const groups = CI.group(agents);
    card.groups = groups;
    card.el.closest('.act-card')?.classList.toggle('ag-rated', groups.some((g) => g.rounds.length)); // (each item's rounds are on its tab: the card's own track would say them again)
    let sel = card.tab || picked.get(card.rows.keys().next().value) || 'main';
    if (sel !== 'main' && !groups.some((g) => g.key === sel)) sel = 'main';
    card.tab = sel;
    paintStrip(card);
    paintItems(card);
    if (card.el.dataset.state !== 'working') { card.held = 0; card.shape = ''; card.panel.style.minHeight = ''; }
    else {
      const shape = groups.map((g) => `${g.key}:${g.ids.length}:${g.rounds.length}`).join('|');
      if (card.shape !== shape) { card.shape = shape; holdTallest(card); }
    }
    show(card, sel);
  }
  function buildTabs(card) {
    card.strip = el('div', { className: 'ag-tabs' });
    card.strip.setAttribute('role', 'tablist');
    card.strip.setAttribute('aria-label', tr('agents.tabs.label'));
    card.strip.addEventListener('click', (e) => { const b = e.target.closest('.ag-tab'); if (b) pick(card, b.dataset.key, false); });
    card.strip.addEventListener('keydown', (e) => {
      const tabs = [...card.strip.querySelectorAll('.ag-tab')];
      const at = tabs.indexOf(document.activeElement);
      const to = at < 0 ? -1 : e.key === 'ArrowRight' ? (at + 1) % tabs.length : e.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
      if (to < 0) return;
      e.preventDefault();
      pick(card, tabs[to].dataset.key, true);
    });
    card.items = el('ul', { className: 'ag-items' });
    card.items.addEventListener('click', (e) => { const li = e.target.closest('.ag-item'); if (li) pick(card, li.dataset.key, false); });
    card.rv = el('div', { className: 'ag-rv', hidden: true });
    card.panel = el('div', { className: 'ag-panel', id: `ag-panel-${++panels}` });
    card.panel.setAttribute('role', 'tabpanel');
    card.list.before(card.panel);
    card.panel.append(card.items, card.rv, card.list);
    card.el.querySelector('.ag-head').after(card.strip);
  }
  function pick(card, key, focus) {
    card.tab = key;
    picked.set(card.rows.keys().next().value, key);
    if (picked.size > 100) picked.delete(picked.keys().next().value);
    paintStrip(card);
    show(card, key);
    if (focus) card.strip.querySelector(`.ag-tab[data-key="${CSS.escape(key)}"]`)?.focus();
  }
  function paintStrip(card) {
    const tabs = [{ key: 'main', label: tr('agents.tabs.main') }, ...card.groups];
    const keys = tabs.map((t) => t.key).join('\n');
    if (card.stripKeys !== keys) {
      card.stripKeys = keys;
      card.strip.replaceChildren(...tabs.map((t, i) => {
        const b = el('button', { type: 'button', className: 'ag-tab', id: `${card.panel.id}-t${i}` });
        b.dataset.key = t.key;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-controls', card.panel.id);
        if (t.key !== 'main') b.append(el('span', { className: 'ag-tab-dot', ariaHidden: 'true' }));
        b.append(el('span', { className: 'ag-tab-text' }), el('span', { className: 'ag-tab-badge', ariaHidden: 'true', textContent: '!', hidden: true }));
        return b;
      }));
    }
    [...card.strip.children].forEach((b, i) => {
      const t = tabs[i];
      const text = t.score == null ? t.label : `${t.label} · ${t.score}`;
      const on = t.key === card.tab;
      if (t.state) b.dataset.state = t.state;
      b.querySelector('.ag-tab-text').textContent = text;
      b.querySelector('.ag-tab-badge').hidden = !t.needsUser;
      b.title = text;
      b.setAttribute('aria-label', t.needsUser ? `${text}, ${tr('agents.tab.needs')}` : text);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }
  // The main tab: a row per item, only the big details (no tool calls, no summaries). A click opens its tab.
  function paintItems(card) {
    card.items.replaceChildren(...card.groups.map((g) => {
      const li = el('li', { className: 'ag-item', title: g.label },
        el('span', { className: 'ag-item-dot', ariaHidden: 'true' }), el('span', { className: 'ag-item-name', textContent: g.label }),
        el('span', { className: 'ag-item-score', textContent: g.score == null ? '' : tr('agents.score', { score: g.score }) }), el('span', { className: 'ag-item-time' }));
      li.dataset.key = g.key;
      li.dataset.state = g.state;
      li._g = g;
      itemTime(li);
      return li;
    }));
  }
  function itemTime(li) {
    const g = li._g;
    li.lastChild.textContent = g?.startedAt ? clock((g.endedAt || Date.now()) - g.startedAt) : '';
  }
  // One item's rounds, on its tab: a chip per round, as the card's own track draws them (step-ui.css .rv-track).
  function paintRv(card, g) {
    if (!g?.rounds.length) { card.rv.hidden = true; return; }
    const track = el('ol', { className: 'rv-track' });
    for (const x of g.rounds) {
      const li = el('li', { className: 'rv-round' + (x.met ? ' met' : '') + (x.pending ? ' pending' : '') });
      li.append(el('span', { className: 'rv-n', textContent: tr('card.review.round', { round: x.round }) }), el('span', { className: 'rv-score', textContent: x.pending ? tr('card.review.pending') : String(x.score) }));
      track.append(li);
    }
    card.rv.replaceChildren(el('span', { className: 'rv-title', textContent: tr('card.review.title') }), track);
    card.rv.hidden = false;
  }
  function show(card, key) {
    const g = key === 'main' ? null : card.groups.find((x) => x.key === key);
    const ids = new Set(g?.ids || []);
    card.items.hidden = Boolean(g);
    for (const [id, row] of card.rows) row.hidden = !ids.has(id);
    paintRv(card, g);
    card.el.dataset.tab = g ? 'item' : 'main';
    const tab = card.strip.querySelector('.ag-tab[aria-selected="true"]');
    if (tab) card.panel.setAttribute('aria-labelledby', tab.id);
  }
  // The panel as tall as its tallest tab (each drawn once within this frame, nothing painted between), never shorter than it was while the run works.
  function holdTallest(card) {
    if (!card.el.isConnected) return;
    card.panel.style.minHeight = '';
    for (const a of card.panel.getAnimations({ subtree: true })) if (Number.isFinite(a.effect?.getComputedTiming?.().endTime)) a.finish(); // (a row still opening would measure short; a dot that pulses for ever is left alone)
    let tallest = card.held || 0;
    for (const key of ['main', ...card.groups.map((g) => g.key)]) { show(card, key); tallest = Math.max(tallest, card.panel.getBoundingClientRect().height); }
    card.held = tallest;
    if (tallest) card.panel.style.minHeight = `${tallest}px`;
  }

  // One clock for every working row on screen, off when none is.
  let ticker = 0;
  function tick() {
    if (ticker) return;
    ticker = setInterval(() => {
      const rows = document.querySelectorAll('.agents-card .ag-row[data-state="working"]');
      if (!rows.length) { clearInterval(ticker); ticker = 0; return; }
      for (const row of rows) paintTime(row);
      for (const li of document.querySelectorAll('.agents-card .ag-item[data-state="working"]')) itemTime(li); // ([card tabs] an item's clock on the main tab)
    }, 1000);
  }

  // An 'agent' event for `turn` (a running reply, or one that ended: the card stays with the reply that started the agent). `place(node)` puts a
  // new card in the chat. A follow-up turn that goes on in the same card (step-ui.js carryOn) shares `turn.agents` with the reply before it.
  function update(turn, event, place) {
    if (!turn || typeof event?.id !== 'string') return false;
    if (event.state === 'working') live.add(event.id); else { live.delete(event.id); endedHere.set(event.id, event); if (endedHere.size > 200) endedHere.delete(endedHere.keys().next().value); }
    const box = (turn.agents ||= { card: null });
    if (!box.card || !box.card.el.isConnected) box.card = turn.cards?.[turn.cards.length - 1]?.el?.querySelector?.('.agents-card')?._ag || null; // (the reply drawn again: its agents, as drawn from what was saved)
    if (!box.card || !box.card.el.isConnected) { box.card = makeCard(); place(box.card.el); }
    const card = box.card;
    let row = card.rows.get(event.id);
    const fresh = !row;
    if (!row) { row = makeRow(event); card.rows.set(event.id, row); card.list.append(row); }
    const was = row._a || {};
    paintRow(row, { ...was, ...event, startedAt: event.startedAt || was.startedAt });
    if (fresh && card.rows.size > 1 && !card.el.classList.contains('ag-tabbed')) window.stepUI?.grow?.(row); // ([steady] a second agent's row opens smoothly; the first comes with its card. [card tabs] On a tabbed card the panel holds its height)
    paintHead(card);
    if (event.state === 'working') tick();
    return true;
  }

  // The agents as a part of an activity card (step-ui.js): under its status line and what the AI said, above its files, tabs and buttons.
  function into(card, node) {
    node.classList.add('in-card');
    const after = card.querySelector(':scope > .act-say') || card.querySelector(':scope > .act-status');
    if (after) after.after(node); else card.append(node);
  }

  // A reopened chat: the card as the reply left it. An agent saved as working is over by now, unless this window still hears from it (the chat
  // drawn again while it works).
  function restore(agents) {
    const list = Array.isArray(agents) ? agents.filter((a) => a && typeof a.id === 'string') : [];
    if (!list.length) return null;
    const card = makeCard();
    for (const a of list) {
      const row = makeRow(a);
      paintRow(row, a.state === 'working' && !live.has(a.id) ? (endedHere.has(a.id) ? { ...a, ...endedHere.get(a.id) } : { ...a, state: 'stopped' }) : a);
      card.rows.set(a.id, row);
      card.list.append(row);
    }
    paintHead(card);
    card.el.classList.add('restored');
    if (list.some((a) => live.has(a.id))) tick();
    return card.el;
  }

  window.agentsCard = { update, restore, into };
})();
