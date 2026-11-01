// [account tabs] The address bar's account chip and the "Use another account" bar (main.js accountUiState, features/account-tabs.js).
// Loaded by app.js the first time main sends a state (an account tab or a sign-in page in front); not part of ui.bundle.js.
// Every action goes back to main (window.browser.accountAct): this file only draws.
(() => {
  const act = (action, arg) => window.browser.accountAct?.(action, arg);
  const tr = (key, english, vars) => {
    const text = window.t ? window.t(key, vars) : key;
    return text === key ? english.replace(/\{(\w+)\}/g, (w, n) => (vars && n in vars ? String(vars[n]) : w)) : text;
  };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const button = (label, onclick, cls) => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', onclick); return b; };
  const below = (node) => { const r = node.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; };

  // The chip, at the start of the address bar's end (next to the translate and reader buttons).
  const end = document.querySelector('.omnibox-end');
  const chip = el('button', 'account-chip');
  chip.type = 'button';
  chip.id = 'account-chip';
  chip.hidden = true;
  chip.setAttribute('aria-haspopup', 'menu');
  const dot = el('span', 'account-dot');
  const name = el('span', 'account-name');
  chip.append(dot, name);
  chip.addEventListener('click', () => act('menu', below(chip)));
  end?.insertBefore(chip, end.firstChild);

  // The bar, under the toolbar with the other infobars.
  const bar = el('div', 'infobar account-bar');
  bar.id = 'account-bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', tr('accounts.region', 'Use another account'));
  bar.hidden = true;
  const after = document.getElementById('password-bar') || document.getElementById('translate-bar');
  if (after) after.after(bar); else document.body.prepend(bar);

  const extensionsList = document.getElementById('extension-actions');
  let shownBar = '';
  let renaming = null;

  function drawChip(account, rename) {
    chip.hidden = !account;
    if (!account) { stopRename(); return; }
    dot.style.background = account.color;
    name.textContent = account.name;
    const label = tr('accounts.chip', '{name}: this tab uses its own sign-ins', { name: account.name });
    chip.title = label;
    chip.setAttribute('aria-label', label);
    if (rename) startRename(account);
  }

  function startRename(account) {
    stopRename();
    const input = el('input', 'account-rename');
    input.value = account.name;
    input.maxLength = 40;
    input.setAttribute('aria-label', tr('accounts.renameLabel', 'Account name'));
    const done = (save) => {
      if (renaming !== input) return;
      const value = input.value.trim();
      stopRename();
      if (save && value && value !== account.name) act('rename', value);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); done(true); } // (not while an IME is composing)
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    input.addEventListener('blur', () => done(true));
    renaming = input;
    chip.hidden = true;
    chip.after(input);
    input.focus();
    input.select();
  }
  function stopRename() {
    if (!renaming) return;
    const input = renaming;
    renaming = null;
    input.remove();
    chip.hidden = !name.textContent;
  }

  function drawBar(info) {
    const key = info ? JSON.stringify(info) : '';
    if (key === shownBar) return;
    shownBar = key;
    if (!info) { bar.hidden = true; bar.replaceChildren(); return; }
    const text = el('span', 'infobar-text', tr('accounts.bar', 'Signing in to {host}? You can use a different account than the one remembered here.', { host: info.host || '' }));
    const use = info.next ? tr('accounts.bar.useNamed', 'Use {name}', { name: info.next }) : info.main ? tr('accounts.bar.useMain', 'Use the main account') : tr('accounts.bar.use', 'Use another account');
    const go = button(use, () => act('use'), 'primary');
    const choose = button('', () => act('choose', below(choose)), 'account-choose');
    choose.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5"/></svg>';
    choose.title = tr('accounts.bar.choose', 'Choose an account');
    choose.setAttribute('aria-label', choose.title);
    choose.setAttribute('aria-haspopup', 'menu');
    const close = button('×', () => act('dismiss'), 'infobar-close');
    close.title = tr('accounts.bar.close', 'Close');
    close.setAttribute('aria-label', close.title);
    bar.replaceChildren(text, go, choose, close);
    bar.hidden = false;
  }

  // The toolbar's extension buttons are those of the tab's own session (each account has its own copy of the extensions).
  function drawExtensions(partition) {
    if (!extensionsList || (extensionsList.getAttribute('partition') || '') === (partition || '')) return;
    try { extensionsList.stopObserving?.(); } catch { /* not defined yet */ }
    if (partition) extensionsList.setAttribute('partition', partition); else extensionsList.removeAttribute('partition');
    try { if (extensionsList.isConnected) extensionsList.startObserving?.(); } catch { /* not defined yet */ }
  }

  window.accountTabs = {
    draw(st) {
      drawChip(st?.account || null, Boolean(st?.renaming));
      drawBar(st?.bar || null);
      drawExtensions(st?.partition || '');
    },
  };
})();
