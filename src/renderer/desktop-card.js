// The "Computer" activity card: the AI working in another program on this PC (src/desktop/). One card per app per run, drawn from
// { type: 'desktop_card', surface: 'app', id, app, title, status, task, thumbnail, icon } events (the same payload shape the browser card
// uses: surface, app, title, status, thumbnail). Kept in its own module so it can be merged with a shared card component later.
//   window.desktopCard.update(event) -> the card's element (created on first sight, updated in place after), with
//   { created: true } when it is new so the caller can place it in the conversation.
// The thumbnail is a data: image main made from a window capture; the only other input is text, always set with textContent.
(() => {
  const tr = (key, vars) => window.t(key, vars);
  const IMAGE = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const cards = new Map(); // id -> element

  const statusText = (status, task) => {
    if (status === 'completed') return tr('desktopcard.completed', { task: task || tr('desktopcard.done') });
    if (status === 'paused') return tr('desktopcard.paused');
    if (status === 'stopped') return tr('desktopcard.stopped');
    return tr('desktopcard.working', { task: task || tr('desktopcard.working.default') });
  };

  function build(event) {
    const card = el('div', { className: 'desktop-card' });
    card.dataset.id = event.id;
    card.setAttribute('role', 'group');
    const icon = el('img', { className: 'dc-icon', alt: '', hidden: true, draggable: false });
    const name = el('div', { className: 'dc-app' });
    const status = el('div', { className: 'dc-status', role: 'status' });
    const open = el('button', { type: 'button', className: 'dc-btn dc-open', textContent: tr('desktopcard.open') });
    const resume = el('button', { type: 'button', className: 'dc-btn dc-resume primary', textContent: tr('desktopcard.resume'), hidden: true });
    const stop = el('button', { type: 'button', className: 'dc-btn dc-stop', textContent: tr('desktopcard.stop'), hidden: true });
    const thumb = el('img', { className: 'dc-thumb', alt: '', hidden: true, draggable: false });
    open.onclick = () => { open.disabled = true; Promise.resolve(window.assistant?.desktopOpen?.(card.dataset.id)).catch(() => {}).finally(() => { open.disabled = false; }); };
    resume.onclick = () => window.assistant?.desktopControl?.('resume');
    stop.onclick = () => window.assistant?.desktopControl?.('stop');
    card.append(
      el('div', { className: 'dc-head' }, icon, el('div', { className: 'dc-meta' }, name, status), el('div', { className: 'dc-bar' }, resume, stop, open)),
      thumb,
    );
    return card;
  }

  function update(event) {
    if (!event || typeof event.id !== 'string') return null;
    let card = cards.get(event.id);
    let created = false;
    if (!card || !card.isConnected) {
      if (card && !card.isConnected) cards.delete(event.id);
      card = build(event);
      cards.set(event.id, card);
      created = true;
      while (cards.size > 60) cards.delete(cards.keys().next().value);
    }
    const q = (sel) => card.querySelector(sel);
    const live = event.status === 'working' || event.status === 'paused';
    card.dataset.status = event.status || 'working';
    q('.dc-app').textContent = String(event.app || tr('desktopcard.app'));
    q('.dc-status').textContent = statusText(event.status, String(event.task || ''));
    card.setAttribute('aria-label', `${q('.dc-app').textContent}: ${q('.dc-status').textContent}`);
    q('.dc-resume').hidden = event.status !== 'paused';
    q('.dc-stop').hidden = !live;
    q('.dc-open').hidden = event.status === 'stopped' && !event.thumbnail;
    if (typeof event.icon === 'string' && IMAGE.test(event.icon)) { const i = q('.dc-icon'); if (i.src !== event.icon) i.src = event.icon; i.hidden = false; }
    if (typeof event.thumbnail === 'string' && IMAGE.test(event.thumbnail)) {
      const t = q('.dc-thumb');
      if (t.src !== event.thumbnail) t.src = event.thumbnail;
      t.alt = tr('desktopcard.thumbAlt', { app: q('.dc-app').textContent });
      t.hidden = false;
    } else if (event.blocked) { const t = q('.dc-thumb'); t.removeAttribute('src'); t.hidden = true; }
    return { card, created };
  }

  window.desktopCard = { update, count: () => cards.size };
})();
