// "New in Lumen" in the empty chat, in the sidebar (index.html, loaded after start by app.js once main has something to
// show) and the full-page chat (chat-page.html). Main (features/feature-offers.js) decides what is listed; this draws it
// above the example chips, grouped by release, newest first. The card lives inside #empty, so it can't appear over a
// conversation or a running task, and a run that starts takes it away with the empty chat. Each line can be changed in
// place, through main (which saves it with the settings setter): a switch, a small choice (one that installs something,
// like uBlock Origin Lite, asks once on the card first), or "Set up…", which opens the feature's section in Settings
// (anything that sends data, like Telegram or voice input, is set up there, never from here).
(() => {
  const api = window.assistant?.offers;
  const empty = document.getElementById('empty');
  if (!api || !empty || window.offerCard) return;
  const tr = (key, vars) => (typeof window.t === 'function' ? window.t(key, vars) : key);
  let card = null;

  const remove = () => { card?.remove(); card = null; };
  const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text !== undefined ? { textContent: text } : {});
  const button = (text, cls, onclick) => Object.assign(el('button', cls, text), { type: 'button', onclick });
  const act = (action, arg) => api.act(action, arg).catch(() => ({ ok: false }));
  const openSettings = (section) => window.lumenPrefs?.openSettingsPage(section || 'general');

  // A switch: saved at once; put back if the save fails.
  function toggle(item, name) {
    const input = Object.assign(el('input', 'offer-switch'), { type: 'checkbox', checked: item.value === true });
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', name);
    input.addEventListener('change', async () => {
      input.disabled = true;
      const r = await act('set', { id: item.id, value: input.checked });
      input.disabled = false;
      if (!r.ok) input.checked = !input.checked;
      if (document.activeElement === document.body) input.focus({ preventScroll: true }); // (disabling it while it saved dropped focus)
    });
    return input;
  }

  // A small choice. A value that installs something asks on the card first ("Use it" / "Cancel").
  function choice(item, name, li) {
    const sel = el('select', 'offer-choice');
    sel.setAttribute('aria-label', name);
    for (const v of item.choices) sel.append(Object.assign(el('option', '', tr(`offers.${item.id}.${v}`)), { value: String(v) }));
    let saved = item.value;
    sel.value = String(saved);
    const valueOf = (s) => item.choices.find((c) => String(c) === s);
    const save = async (v) => {
      sel.disabled = true;
      const r = await act('set', { id: item.id, value: v });
      sel.disabled = false;
      if (r.ok) saved = v;
      sel.value = String(saved);
      if (document.activeElement === document.body) sel.focus({ preventScroll: true }); // (as the switch)
    };
    sel.addEventListener('change', () => {
      li.querySelector('.offer-confirm')?.remove();
      const v = valueOf(sel.value);
      if (v === undefined) return;
      if (item.confirm === undefined || v !== item.confirm) { save(v); return; }
      const ask = el('div', 'offer-confirm');
      ask.setAttribute('role', 'group');
      const text = el('span', 'offer-confirm-text', tr(`offers.${item.id}.${v}.confirm`));
      text.id = `offer-confirm-${item.id}`;
      ask.setAttribute('aria-labelledby', text.id);
      const close = (keep) => { ask.remove(); if (!keep) sel.value = String(saved); sel.focus(); };
      const go = button(tr('offers.useIt'), 'offer-go', () => { close(true); save(v); });
      const actions = el('div', 'offer-confirm-actions');
      actions.append(button(tr('offers.cancel'), 'link-btn', () => close(false)), go);
      ask.append(text, actions);
      ask.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } }); // (Esc backs out of the question, not the card)
      li.append(ask);
      go.focus();
    });
    return sel;
  }

  function row(item) {
    const li = el('li', 'offer-row');
    li.dataset.offer = item.id;
    const text = el('span', 'offer-text');
    const name = el('span', 'offer-name', tr(`offers.${item.id}`));
    text.append(name, el('span', 'offer-desc', tr(`offers.${item.id}.desc`)));
    li.append(text);
    if (item.kind === 'toggle') li.append(toggle(item, name.textContent));
    else if (item.kind === 'choice') li.append(choice(item, name.textContent, li));
    else if (item.kind === 'setup') {
      const go = button(tr('offers.setUp'), 'offer-go', async () => {
        go.disabled = true;
        const r = await act('act', item.id);
        if (!r.ok) { go.disabled = false; return; }
        if (r.section) openSettings(r.section);
        const list = li.parentElement;
        const next = li.nextElementSibling || li.previousElementSibling;
        li.remove();
        next?.querySelector('input, select, button')?.focus({ preventScroll: true }); // (keyboard focus stays on the card)
        if (list && !list.querySelector('.offer-row')) { list.previousElementSibling?.remove(); list.remove(); } // (and its release heading)
        if (!card?.querySelector('.offer-row')) remove();
      });
      go.setAttribute('aria-label', `${go.textContent} ${name.textContent}`);
      li.append(go);
    }
    return li;
  }

  async function show(given) {
    if (card) return;
    let list = given || null;
    if (!list) { try { list = await api.get(); } catch { /* no card */ } }
    if (!list?.items?.length || card || document.getElementById('welcome')?.hidden === false) return; // (the first-run welcome has its own steps)
    card = el('section', 'offer-card');
    card.setAttribute('role', 'region');
    card.setAttribute('aria-labelledby', 'offer-title');
    const head = el('div', 'offer-head');
    const mark = el('span', 'offer-mark');
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5c.3 0 .5.2.6.5l.9 2.9c.2.7.8 1.3 1.5 1.5l2.9.9c.3.1.5.3.5.6s-.2.5-.5.6l-2.9.9c-.7.2-1.3.8-1.5 1.5l-.9 2.9c-.1.3-.3.5-.6.5s-.5-.2-.6-.5l-.9-2.9c-.2-.7-.8-1.3-1.5-1.5L2.1 8.6c-.3-.1-.5-.3-.5-.6s.2-.5.5-.6L5 6.5c.7-.2 1.3-.8 1.5-1.5L7.4 2c.1-.3.3-.5.6-.5z"/></svg>';
    head.append(mark, Object.assign(el('h3', 'offer-title', tr('offers.title')), { id: 'offer-title' }));
    card.append(head);
    const releases = [...new Set(list.items.map((i) => i.since))];
    for (const since of releases) {
      card.append(el('h4', 'offer-release', tr('offers.release', { version: since })));
      const ul = el('ul', 'offer-list');
      for (const item of list.items.filter((i) => i.since === since)) ul.append(row(item));
      card.append(ul);
    }
    const foot = el('div', 'offer-foot');
    if (list.more > 0) foot.append(button(tr('offers.more', { n: list.more }), 'link-btn offer-more', () => openSettings(list.moreSection)));
    const dismiss = async (how) => {
      const hadFocus = card?.contains(document.activeElement);
      remove();
      if (hadFocus) document.getElementById('prompt')?.focus(); // (not lost to the page)
      await act('dismiss', how);
    };
    foot.append(
      button(tr('offers.notNow'), 'link-btn offer-later', () => dismiss()),
      button(tr('offers.never'), 'link-btn offer-never', () => dismiss('never')));
    card.append(foot);
    card.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); dismiss(); } }); // Esc = Not now
    (empty.querySelector('.chips') || empty).before(card);
    // Counted as shown once it has really been on screen (the next launch doesn't show it again).
    const ids = list.items.map((i) => i.id);
    const seenOnce = () => { if (card && card.offsetParent !== null && !document.hidden) { io.disconnect(); act('shown', ids); } };
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) seenOnce(); });
    io.observe(card);
  }

  window.offerCard = { show };
  // After the page has settled (the first-run welcome, the restored chat); once the chat is empty again, show what is left.
  setTimeout(show, 600); // (main answers once startup has decided what is new, however long that takes)
  window.addEventListener('focus', () => { if (!card) setTimeout(show, 100); });
})();
