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
    const main = el('div', { className: 'ag-main' }, el('div', { className: 'ag-line' }, name, bg), now);
    row.append(el('span', { className: 'ag-dot', ariaHidden: 'true' }), main, el('div', { className: 'ag-meta' }, time, tools));
    row._p = { name, bg, now, time, tools };
    // A finished agent's summary is cut to two lines; the row opens to show all of it.
    row.addEventListener('click', () => { if (row.dataset.state !== 'working' && row._a?.summary) row.classList.toggle('open'); });
    return row;
  }

  function paintRow(row, a) {
    row._a = a;
    const p = row._p;
    row.dataset.state = a.state;
    p.name.textContent = a.desc || tr('agents.unnamed');
    p.bg.hidden = !a.background;
    const ended = ENDED.has(a.state);
    const text = ended ? (a.summary || tr(`agents.state.${a.state}`)) : (a.last || tr('agents.starting'));
    if (p.now.textContent !== text) p.now.textContent = text;
    row.tabIndex = ended && a.summary ? 0 : -1;
    p.tools.textContent = a.tools ? tr(a.tools === 1 ? 'agents.tools.one' : 'agents.tools.other', { count: a.tools }) : '';
    paintTime(row);
    row.setAttribute('aria-label', `${p.name.textContent}: ${ended ? tr(`agents.state.${a.state}`) : tr('agents.state.working')}. ${text}`);
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
    card.el.setAttribute('aria-label', `${tr('agents.title')}: ${card.sub.textContent}`);
  }

  // One clock for every working row on screen, off when none is.
  let ticker = 0;
  function tick() {
    if (ticker) return;
    ticker = setInterval(() => {
      const rows = document.querySelectorAll('.agents-card .ag-row[data-state="working"]');
      if (!rows.length) { clearInterval(ticker); ticker = 0; return; }
      for (const row of rows) paintTime(row);
    }, 1000);
  }

  // An 'agent' event for `turn` (a running reply, or one that ended: the card stays with the reply that started the agent). `place(node)` puts a
  // new card in the chat. A follow-up turn that goes on in the same card (step-ui.js carryOn) shares `turn.agents` with the reply before it.
  function update(turn, event, place) {
    if (!turn || typeof event?.id !== 'string') return false;
    if (event.state === 'working') live.add(event.id); else live.delete(event.id);
    const box = (turn.agents ||= { card: null });
    if (!box.card || !box.card.el.isConnected) box.card = turn.cards?.[turn.cards.length - 1]?.el?.querySelector?.('.agents-card')?._ag || null; // (the reply drawn again: its agents, as drawn from what was saved)
    if (!box.card || !box.card.el.isConnected) { box.card = makeCard(); place(box.card.el); }
    const card = box.card;
    let row = card.rows.get(event.id);
    if (!row) { row = makeRow(event); card.rows.set(event.id, row); card.list.append(row); }
    const was = row._a || {};
    paintRow(row, { ...was, ...event, startedAt: event.startedAt || was.startedAt });
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
      paintRow(row, a.state === 'working' && !live.has(a.id) ? { ...a, state: 'stopped' } : a);
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
