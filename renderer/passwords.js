// [passwords] The "Save password?" bar and the key button in the address field. main.js
// (features/passwords.js) owns the state and sends it with every tab update (tab.passwords): the site,
// how many logins are saved for it, and an offer's username. No password ever reaches this window; Save
// tells main.js to keep the one it is holding, and the key button asks main.js for its Fill menu.
(() => {
  const bar = document.getElementById('password-bar');
  const end = document.querySelector('.omnibox-end');
  if (!bar || !end || !window.browser?.passwordsAct) return;
  const tr = (key, english, vars) => {
    const text = window.t ? window.t(key, vars) : key;
    return text === key ? english.replace(/\{(\w+)\}/g, (w, n) => (vars && n in vars ? String(vars[n]) : w)) : text;
  };
  const act = (action) => window.browser.passwordsAct(action);

  const btn = document.createElement('button');
  btn.className = 'omnibox-action passwords-btn';
  btn.id = 'passwords-btn';
  btn.type = 'button';
  btn.hidden = true;
  btn.setAttribute('aria-haspopup', 'menu');
  btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5.5" cy="10.5" r="3"/><path d="M7.6 8.4 13.5 2.5M11.5 4.5l1.5 1.5M10 6l1.2 1.2"/></svg>';
  end.insertBefore(btn, document.getElementById('translate-btn') || document.getElementById('reader') || end.firstChild);
  btn.addEventListener('click', () => act('menu'));

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const button = (label, onclick, cls) => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', onclick); return b; };
  let shown = '';

  function draw(st) {
    btn.hidden = !st?.saved;
    const label = tr('passwords.button', 'Saved passwords for this site');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    const offer = st?.offer || null;
    const key = offer ? `${offer.site}|${offer.username}|${offer.update}` : '';
    if (key === shown) return;
    shown = key;
    if (!offer) { bar.hidden = true; bar.replaceChildren(); return; }
    const vars = { site: offer.site, username: offer.username };
    const text = el('span', 'infobar-text', offer.update
      ? tr('passwords.offer.update', 'Update the saved password for {username} on {site}?', vars)
      : tr('passwords.offer', 'Save password for {site}?', vars));
    if (!offer.update) text.append(' ', el('span', 'infobar-note', offer.username || tr('passwords.noUsername', 'no username')));
    const parts = [button(offer.update ? tr('passwords.offer.updateButton', 'Update') : tr('passwords.offer.save', 'Save'), () => act('save'), 'primary')];
    if (!offer.update) parts.push(button(tr('passwords.offer.never', 'Never for this site'), () => act('never')));
    parts.push(button(tr('passwords.offer.notNow', 'Not now'), () => act('not-now')));
    const x = el('button', 'infobar-close', '×');
    x.type = 'button';
    x.setAttribute('aria-label', tr('passwords.offer.close', 'Close'));
    x.addEventListener('click', () => act('not-now'));
    bar.replaceChildren(text, ...parts, x);
    bar.hidden = false;
  }

  window.browser.onTabs((state) => {
    const active = state?.tabs?.find((t) => t.id === state.activeId);
    draw(active?.passwords || null);
  });
})();
