// The downloads panel (the toolbar button): rows from features/downloads.js (panelEntry), actions
// back by id; "Show all downloads" opens the Downloads page (downloads.html). A
// finished file can be dragged out (main.js starts a native file drag), opened with a click or
// Enter, or shown in its folder. The wording is locales/en.json (dlpanel.*), through window.t (i18n.js).
//
// Progress arrives many times a second. Each download keeps one row for as long as it is listed
// (`rows`, by download id) and an update patches that row's text, bar, state and buttons in place, so a
// press that began on a row still ends on the same element (a rebuilt row dropped the click) and the
// focused button stays focused.
(() => {
  const api = window.downloadsPanel;
  const t = window.t || ((key) => key);
  const $ = (id) => document.getElementById(id);
  const list = $('list');
  const card = $('card');
  let items = [];
  let selected = -1;
  const rows = new Map(); // download id -> { li, d, name, status, text, bar, fill, actions, iconSrc, fresh }
  const seen = new Set(); // ids already drawn once: only new rows animate in

  const ICONS = {
    pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
    resume: '<path d="M5 3.2v9.6L12.5 8z"/>',
    cancel: '<path d="M4 4l8 8M12 4l-8 8"/>',
    retry: '<path d="M12.5 8a4.5 4.5 0 1 1-1.4-3.3M12.5 3v2.6H9.9"/>',
    show: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3 3"/>',
    file: '<path d="M4 1.8h5.2L13 5.6v8.1c0 .3-.2.5-.5.5h-8.5a.5.5 0 0 1-.5-.5V2.3c0-.3.2-.5.5-.5zM9 1.8v4h4"/>',
  };
  const svg = (name, box = 16) => `<svg viewBox="0 0 ${box} ${box}" aria-hidden="true">${ICONS[name === 'remove' ? 'cancel' : name]}</svg>`;

  const size = (n) => {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const v = n / 1024 ** i;
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  };
  const duration = (s) => {
    if (!Number.isFinite(s) || s <= 0) return '';
    if (s < 60) return t('dlpanel.left.s', { n: Math.ceil(s) });
    if (s < 3600) return t('dlpanel.left.min', { n: Math.ceil(s / 60) });
    return t('dlpanel.left.hour', { h: Math.floor(s / 3600), m: Math.ceil((s % 3600) / 60) });
  };
  const when = (time) => {
    if (!time) return '';
    const d = new Date(time);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  function statusOf(d) {
    if (d.state === 'progressing') {
      if (d.awaitingOk) return t('dlpanel.awaitingOk');
      // "3.0 of 47.7 MB" when both sizes share a unit, so speed and time left still fit.
      const [got, all] = [size(d.received), size(d.total)];
      const unit = (text) => text.split(' ')[1];
      const of = !d.total ? got : t('dlpanel.of', { got: unit(got) === unit(all) ? got.split(' ')[0] : got, all });
      if (d.paused) return t('dlpanel.paused', { progress: of });
      const eta = d.total && d.speed ? duration((d.total - d.received) / d.speed) : '';
      return [of, d.speed ? t('dlpanel.speed', { speed: size(d.speed) }) : '', eta].filter(Boolean).join(' · ');
    }
    if (d.state === 'completed') return d.missing ? t('dlpanel.deleted') : [size(d.total || d.received), d.host, when(d.endedAt)].filter(Boolean).join(' · ');
    if (d.state === 'cancelled') return [t('dlpanel.canceled'), d.host].filter(Boolean).join(' · ');
    return [t('dlpanel.failed'), d.host].filter(Boolean).join(' · ');
  }
  function actionsOf(d) {
    if (d.state === 'progressing') return d.awaitingOk ? ['cancel'] : [d.paused ? 'resume' : 'pause', 'cancel'];
    if (d.state === 'completed') return d.missing ? ['remove'] : ['show', 'remove'];
    return [d.canResume ? 'resume' : 'retry', 'remove'];
  }
  const openable = (d) => d.state === 'completed' && !d.missing;

  // Sets a property or attribute only when it differs: an update that changes nothing touches nothing.
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const setAttr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };

  function makeRow(d) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    const icon = document.createElement('div');
    icon.className = 'icon';
    const text = document.createElement('div');
    text.className = 'text';
    const name = Object.assign(document.createElement('div'), { className: 'name' });
    const status = Object.assign(document.createElement('div'), { className: 'status' });
    text.append(name, status);
    const actions = document.createElement('div');
    actions.className = 'actions';
    li.append(icon, text, actions);
    const row = { li, d, icon, name, status, text, bar: null, fill: null, actions, iconSrc: undefined, fresh: !seen.has(d.id) };
    // Handlers read row.d: the row outlives any one update of its download.
    li.addEventListener('click', () => { if (openable(row.d)) { api.act('open', row.d.id); api.close(); } });
    li.addEventListener('dragstart', (e) => { e.preventDefault(); if (openable(row.d)) api.drag(row.d.id); });
    li.addEventListener('animationend', () => { row.fresh = false; });
    return row;
  }

  function patchActions(row, d) {
    const wanted = actionsOf(d);
    wanted.forEach((a, k) => {
      let b = row.actions.children[k];
      if (!b) {
        b = document.createElement('button');
        b.type = 'button';
        b.className = 'act';
        // (The same button turns from Pause into Resume: it keeps focus, and a press stays a press on it.)
        b.addEventListener('click', (e) => { e.stopPropagation(); api.act(b.dataset.action, row.d.id); });
        row.actions.append(b);
      }
      const label = t(`dlpanel.action.${a}`);
      if (b.dataset.action !== a) { b.dataset.action = a; b.innerHTML = svg(a); }
      setAttr(b, 'title', label);
      setAttr(b, 'aria-label', t('dlpanel.action.label', { action: label, name: d.name }));
    });
    while (row.actions.children.length > wanted.length) row.actions.children[wanted.length].remove();
  }

  function patchBar(row, d) {
    const want = d.state === 'progressing' && !d.awaitingOk;
    if (!want) {
      if (row.bar) { row.bar.remove(); row.bar = row.fill = null; }
      return;
    }
    if (!row.bar) {
      row.bar = document.createElement('div');
      row.fill = document.createElement('i');
      row.bar.append(row.fill);
      row.text.append(row.bar);
    }
    const cls = `bar${d.total ? '' : ' unknown'}`;
    if (row.bar.className !== cls) row.bar.className = cls;
    const width = d.total ? `${Math.min(100, (d.received / d.total) * 100).toFixed(1)}%` : '';
    if (row.fill.style.width !== width) row.fill.style.width = width;
  }

  function patchRow(row, d, i) {
    row.d = d;
    const { li } = row;
    const cls = [d.state, d.paused ? 'paused' : '', d.missing ? 'missing' : '', d.state === 'interrupted' ? 'failed' : '', openable(d) ? 'openable' : '', i === selected ? 'selected' : '', row.fresh ? 'fresh' : ''].filter(Boolean).join(' ');
    if (li.className !== cls) li.className = cls;
    li.dataset.index = String(i);
    setAttr(li, 'aria-selected', String(i === selected));
    li.draggable = openable(d);
    if (openable(d)) setAttr(li, 'title', t('dlpanel.openTip', { name: d.name }));
    else if (li.hasAttribute('title')) li.removeAttribute('title');
    if (row.iconSrc !== (d.icon || '')) {
      row.iconSrc = d.icon || '';
      if (d.icon) { const img = document.createElement('img'); img.src = d.icon; img.alt = ''; row.icon.replaceChildren(img); } else row.icon.innerHTML = svg('file');
    }
    setText(row.name, d.name);
    setText(row.status, statusOf(d));
    patchBar(row, d);
    patchActions(row, d);
  }

  function render() {
    const live = new Set(items.map((d) => d.id));
    for (const [id, row] of rows) if (!live.has(id)) { row.li.remove(); rows.delete(id); }
    items.forEach((d, i) => {
      let row = rows.get(d.id);
      if (!row) { row = makeRow(d); rows.set(d.id, row); }
      patchRow(row, d, i);
      if (list.children[i] !== row.li) list.insertBefore(row.li, list.children[i] || null); // (only a row out of place moves)
    });
    for (const d of items) seen.add(d.id);
    $('empty').hidden = items.length > 0;
    $('hint').hidden = !items.some(openable);
    $('clear').hidden = !items.some((d) => d.state !== 'progressing');
    requestAnimationFrame(reportHeight);
  }

  // The view is sized to the card (main.js caps it to the window). On a short window the card is cut
  // to the view and the list scrolls (downloads-panel.html), so this reports the card's natural height
  // (the list at its full, uncapped-by-the-window size): the clipped height would shrink the view,
  // which would shrink the card again, and so on.
  function reportHeight() {
    const natural = card.getBoundingClientRect().height - list.clientHeight + Math.min(list.scrollHeight, 452);
    api.setHeight(Math.ceil(natural) + 6 + 24);
  }
  new ResizeObserver(reportHeight).observe(card);

  api.onList((next) => { items = Array.isArray(next) ? next : []; if (selected >= items.length) selected = items.length - 1; render(); });
  api.onOpen(() => {
    selected = -1;
    card.classList.remove('entering');
    void card.offsetWidth; // restart the animation
    card.classList.add('entering');
    list.scrollTop = 0;
    render();
  });
  $('folder').addEventListener('click', () => api.openFolder());
  $('show-all').addEventListener('click', () => api.showAll());
  $('clear').addEventListener('click', () => api.clear());

  // Keyboard: arrows move, Enter opens, Delete removes, Escape closes.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { api.close(); return; }
    if (!items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      selected = e.key === 'ArrowDown' ? Math.min(items.length - 1, selected + 1) : Math.max(0, selected - 1);
      render();
      list.children[selected]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && items[selected] && openable(items[selected])) {
      api.act('open', items[selected].id);
      api.close();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && items[selected] && items[selected].state !== 'progressing') {
      api.act('remove', items[selected].id);
    }
  });
})();
