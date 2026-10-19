// "New in Lumen: want to turn these on?" in the empty chat, in the sidebar (index.html) and the full-page chat
// (chat-page.html). Main (features/feature-offers.js) decides what is listed; this draws it above the example chips.
// The card lives inside #empty, so it can't appear over a conversation or a running task, and a run that starts
// takes it away with the empty chat. "Turn on" flips a setting through main; "Set up" opens the feature's section in
// Settings (anything that sends data, like Telegram or voice input, is set up there, never from here).
(() => {
  const api = window.assistant?.offers;
  const empty = document.getElementById('empty');
  if (!api || !empty) return;
  const tr = (key, vars) => (typeof window.t === 'function' ? window.t(key, vars) : key);
  let card = null;

  const remove = () => { card?.remove(); card = null; };
  const button = (text, cls, onclick) => Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: text, onclick });
  const act = (action, arg) => api.act(action, arg).catch(() => ({ ok: false }));

  function row(item) {
    const li = document.createElement('li');
    li.className = 'offer-row';
    li.dataset.offer = item.id;
    const text = document.createElement('span');
    text.className = 'offer-text';
    const name = Object.assign(document.createElement('span'), { className: 'offer-name', textContent: tr(`offers.${item.id}`) });
    const desc = Object.assign(document.createElement('span'), { className: 'offer-desc', textContent: tr(`offers.${item.id}.desc`) });
    text.append(name, desc);
    const setup = item.kind === 'setup';
    const go = button(tr(setup ? 'offers.setUp' : 'offers.turnOn'), 'offer-go', async () => {
      go.disabled = true;
      const r = await act('act', item.id);
      if (!r.ok) { go.disabled = false; return; }
      if (r.section) window.lumenPrefs?.openSettingsPage(r.section);
      li.remove();
      if (!card?.querySelector('.offer-row')) remove();
    });
    go.setAttribute('aria-label', `${go.textContent}: ${name.textContent}`);
    li.append(text, go);
    return li;
  }

  async function show() {
    if (card) return;
    let list = null;
    try { list = await api.get(); } catch { /* no card */ }
    if (!list?.items?.length || card || document.getElementById('welcome')?.hidden === false) return; // (the first-run welcome has its own steps)
    card = document.createElement('section');
    card.className = 'offer-card';
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', tr('offers.title'));
    const title = Object.assign(document.createElement('h3'), { className: 'offer-title', textContent: tr('offers.title') });
    const ul = document.createElement('ul');
    ul.className = 'offer-list';
    for (const item of list.items) ul.append(row(item));
    const foot = document.createElement('div');
    foot.className = 'offer-foot';
    foot.append(
      button(tr('offers.notNow'), 'link-btn offer-later', async () => { remove(); await act('dismiss'); }),
      button(tr('offers.never'), 'link-btn offer-never', async () => { remove(); await act('dismiss', 'never'); }));
    card.append(title, ul, foot);
    (empty.querySelector('.chips') || empty).before(card);
    // Counted as offered once it has really been on screen (the next launch doesn't show it again).
    const ids = list.items.map((i) => i.id);
    const seenOnce = () => { if (card && card.offsetParent !== null && !document.hidden) { io.disconnect(); act('shown', ids); } };
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) seenOnce(); });
    io.observe(card);
  }

  // After the page has settled (the first-run welcome, the restored chat); once the chat is empty again, show what is left.
  setTimeout(show, 600); // (main answers once startup has decided what is new, however long that takes)
  window.addEventListener('focus', () => { if (!card) setTimeout(show, 100); });
})();
