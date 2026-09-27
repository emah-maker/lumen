// A themed menu for a <select> (the model pickers). Native select popups are drawn by the OS
// and don't always follow Lumen's theme, so the list is drawn in the page instead. The <select>
// stays in the DOM (visually hidden) as the source of truth: set .value or dispatch 'change' as
// before, and call select.pickerSync() after changing .value from script.
window.lumenPicker = (select, { label = (o) => o.textContent } = {}) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'picker-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  if (select.getAttribute('aria-label')) button.setAttribute('aria-label', select.getAttribute('aria-label'));
  const text = Object.assign(document.createElement('span'), { className: 'picker-text' });
  button.append(text);
  const menu = Object.assign(document.createElement('div'), { className: 'picker-menu', hidden: true });
  menu.setAttribute('role', 'listbox');
  select.classList.add('picker-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.after(button, menu);

  const sync = () => {
    const option = select.selectedOptions[0];
    text.textContent = option ? label(option) : '';
    button.title = option?.title || '';
  };
  select.pickerSync = sync;
  select.addEventListener('change', sync);
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true });

  let items = [];
  const focusItem = (i) => { items[(i + items.length) % items.length]?.focus(); };
  function close(refocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) button.focus();
  }
  function outside(e) { if (!menu.contains(e.target) && e.target !== button && !button.contains(e.target)) close(false); }
  function choose(value) {
    close();
    if (select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function open() {
    items = [];
    const entry = (o) => {
      const item = Object.assign(document.createElement('div'), { className: 'picker-item', tabIndex: -1, textContent: o.textContent, title: o.title || '' });
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(o.selected));
      item.dataset.value = o.value;
      item.addEventListener('click', () => choose(o.value));
      items.push(item);
      return item;
    };
    menu.replaceChildren(...[...select.children].flatMap((child) => (child.tagName === 'OPTGROUP'
      ? [Object.assign(document.createElement('div'), { className: 'picker-group', textContent: child.label }), ...[...child.children].map(entry)]
      : [entry(child)])));
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    const selected = items.find((i) => i.getAttribute('aria-selected') === 'true') || items[0];
    selected?.focus();
    selected?.scrollIntoView({ block: 'nearest' });
  }
  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  button.addEventListener('keydown', (e) => { if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); open(); } });
  menu.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') focusItem(i + 1);
    else if (e.key === 'ArrowUp') focusItem(i - 1);
    else if (e.key === 'Home') focusItem(0);
    else if (e.key === 'End') focusItem(-1);
    else if (e.key === 'Enter' || e.key === ' ') { if (i >= 0) choose(items[i].dataset.value); }
    else if (e.key === 'Escape' || e.key === 'Tab') close(e.key === 'Escape');
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  sync();
  return { button, menu, sync };
};
